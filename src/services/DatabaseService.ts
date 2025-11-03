import { Pool, PoolClient, QueryResult } from 'pg';
import { ConfigService } from './ConfigService.js';
import { LoggingService } from './LoggingService.js';
import type winston from 'winston';

export class DatabaseService {
  private static instance: DatabaseService | undefined;
  private readonly pool: Pool;
  private readonly logger: winston.Logger;
  private isPoolClosed: boolean = false;
  private activeOperationsCount: number = 0;
  private closePoolPromise: Promise<void> | null = null;
  private closePoolResolve: (() => void) | null = null;

  private constructor(pool: Pool) {
    this.pool = pool;
    this.logger = LoggingService.getInstance().getLogger('Database');
  }

  public static async initialize(): Promise<void> {
    if (DatabaseService.instance) {
      throw new Error('DatabaseService has already been initialized.');
    }

    const dbConfig = ConfigService.getInstance().getDbConfig();
    const logger = LoggingService.getInstance().getLogger('Database');

    const pool = new Pool({
      host: dbConfig.host,
      port: dbConfig.port,
      user: dbConfig.user,
      password: dbConfig.password,
      database: dbConfig.database,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });

    try {
      const startTime = Date.now();
      await pool.query('SELECT NOW()');
      const duration = Date.now() - startTime;

      DatabaseService.instance = new DatabaseService(pool);
      logger.info(`Database connection established successfully (${duration}ms)`);
    } catch (error) {
      logger.error('FATAL: Failed to connect to database:', error);
      await pool.end();
      process.exit(1);
    }
  }

  public static getInstance(): DatabaseService {
    if (!DatabaseService.instance) {
      throw new Error('DatabaseService has not been initialized. Call initialize() first.');
    }
    return DatabaseService.instance;
  }

  public async query(text: string, params: unknown[] = []): Promise<QueryResult> {
    // ???? ?????????? ???????? ???????? ????, ???? ?? ???????
    if (this.closePoolPromise) {
      await this.closePoolPromise;
    }

    if (this.isPoolClosed) {
      throw new Error('Cannot execute query: database pool is closed');
    }

    this.activeOperationsCount++;
    const startTime = Date.now();

    try {
      this.logger.debug(`Executing query: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`);
      const result = await this.pool.query(text, params);
      const duration = Date.now() - startTime;
      this.logger.debug(`Query completed in ${duration}ms (rows: ${result.rowCount})`);
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('Cannot use a pool after calling end')) {
        this.isPoolClosed = true;
        this.logger.error(`Query failed: database pool was closed (${duration}ms)`);
        throw new Error('Cannot execute query: database pool is closed');
      }
      this.logger.error(`Query failed after ${duration}ms:`, error);
      throw error;
    } finally {
      this.activeOperationsCount--;
      if (this.closePoolResolve && this.activeOperationsCount === 0) {
        this.closePoolResolve();
        this.closePoolResolve = null;
      }
    }
  }

  public async executeInTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    // ???? ?????????? ???????? ???????? ????, ???? ?? ???????
    if (this.closePoolPromise) {
      await this.closePoolPromise;
    }

    if (this.isPoolClosed) {
      throw new Error('Cannot execute transaction: database pool is closed');
    }

    this.activeOperationsCount++;
    let client: PoolClient | null = null;

    try {
      client = await this.pool.connect();
      this.logger.debug('Transaction client acquired. Beginning transaction...');
      await client.query('BEGIN');

      const result = await callback(client);

      await client.query('COMMIT');
      this.logger.debug('Transaction COMMITTED.');

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('Cannot use a pool after calling end')) {
        this.isPoolClosed = true;
        this.logger.error('Transaction failed: database pool was closed');
        throw new Error('Cannot execute transaction: database pool is closed');
      }

      if (client) {
        try {
          await client.query('ROLLBACK');
          this.logger.error('Transaction ROLLED BACK due to error:', error);
        } catch (rollbackError) {
          const rollbackErrorMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          if (rollbackErrorMessage.includes('Cannot use a pool after calling end')) {
            this.isPoolClosed = true;
            this.logger.error('Rollback failed: database pool was closed');
          } else {
            this.logger.error('Error during ROLLBACK:', rollbackError);
          }
        }
      }
      throw error;
    } finally {
      if (client) {
        try {
          client.release();
          this.logger.debug('Transaction client released.');
        } catch (releaseError) {
          const releaseErrorMessage = releaseError instanceof Error ? releaseError.message : String(releaseError);
          if (releaseErrorMessage.includes('Cannot use a pool after calling end')) {
            this.isPoolClosed = true;
            this.logger.error('Client release failed: database pool was closed');
          } else {
            this.logger.error('Error releasing client:', releaseError);
          }
        }
      }
      this.activeOperationsCount--;
      if (this.closePoolResolve && this.activeOperationsCount === 0) {
        this.closePoolResolve();
        this.closePoolResolve = null;
      }
    }
  }

  public async closePool(): Promise<void> {
    if (this.isPoolClosed) {
      this.logger.warn('Database pool is already closed.');
      return;
    }

    this.logger.info('Closing database connection pool...');

    // ????????????? ???? ????????, ????? ????? ???????? ?? ???????? ???????????
    this.isPoolClosed = true;

    // ???? ?????????? ???? ???????? ????????
    if (this.activeOperationsCount > 0) {
      this.logger.info(`Waiting for ${this.activeOperationsCount} active operations to complete...`);

      // ??????? Promise, ??????? ?????????? ????? ??? ???????? ??????????
      this.closePoolPromise = new Promise<void>((resolve) => {
        this.closePoolResolve = resolve;
      });

      // ???? ??????? ??? ???? ?? 0, ????????? ?????
      // ???? ?????????? ???? ???????? (? ????????? ?? ?????? ???????)
      await Promise.race([
        this.closePoolPromise,
        new Promise<void>((resolve) => {
          setTimeout(() => {
            this.logger.warn(
              `Timeout waiting for operations to complete. Active operations: ${this.activeOperationsCount}. Proceeding with pool closure.`,
            );
            resolve();
          }, 30000); // 30 ?????? ???????
        }),
      ]);
    }

    try {
      await this.pool.end();
      this.logger.info('Database connection pool closed.');
    } catch (error) {
      this.logger.error('Error closing database pool:', error);
      throw error;
    } finally {
      this.closePoolPromise = null;
      this.closePoolResolve = null;
    }
  }
}
