#!/usr/bin/env tsx
/**
 * MCP сервер для PostgreSQL
 * Используется Cursor для работы с базой данных через MCP протокол
 * Работает в режиме stdio для интеграции с MCP
 */

import { ConfigService } from '../src/services/ConfigService.js';
import dotenv from 'dotenv';
import { spawn } from 'child_process';

// Загружаем конфигурацию
dotenv.config();
ConfigService.load();

const dbConfig = ConfigService.getInstance().getDbConfig();

// Формируем connection string для PostgreSQL
const connectionString = `postgresql://${dbConfig.user}:${dbConfig.password}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`;

// Запускаем MCP сервер через npx
// stdio: 'inherit' передает stdin/stdout/stderr напрямую для работы с MCP протоколом
const mcpServer = spawn('npx', ['-y', '@modelcontextprotocol/server-postgres', connectionString], {
  stdio: 'inherit',
  cwd: process.cwd(),
});

mcpServer.on('error', (error) => {
  console.error('Ошибка при запуске MCP сервера:', error);
  process.exit(1);
});

mcpServer.on('exit', (code) => {
  process.exit(code ?? 0);
});

// Обработка сигналов для корректного завершения
process.on('SIGINT', () => {
  mcpServer.kill('SIGINT');
});

process.on('SIGTERM', () => {
  mcpServer.kill('SIGTERM');
});
