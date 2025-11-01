#!/usr/bin/env tsx
/**
 * Скрипт для запуска MCP сервера PostgreSQL
 * Использует параметры подключения из ConfigService
 */

import { ConfigService } from '../src/services/ConfigService.js';
import dotenv from 'dotenv';

// Загружаем конфигурацию
dotenv.config();
ConfigService.load();

const dbConfig = ConfigService.getInstance().getDbConfig();

// Формируем connection string для PostgreSQL
const connectionString = `postgresql://${dbConfig.user}:${dbConfig.password}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`;

console.log('Запуск MCP сервера для PostgreSQL...');
console.log(`Подключение к: ${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);

// Запускаем MCP сервер через npx
import { spawn } from 'child_process';

const mcpServer = spawn('npx', ['-y', '@modelcontextprotocol/server-postgres', connectionString], {
  stdio: 'inherit',
  shell: true,
});

mcpServer.on('error', (error) => {
  console.error('Ошибка при запуске MCP сервера:', error);
  process.exit(1);
});

mcpServer.on('exit', (code) => {
  console.log(`MCP сервер завершил работу с кодом: ${code}`);
  process.exit(code ?? 0);
});

// Обработка сигналов для корректного завершения
process.on('SIGINT', () => {
  console.log('\nПолучен сигнал SIGINT, завершение работы...');
  mcpServer.kill('SIGINT');
});

process.on('SIGTERM', () => {
  console.log('\nПолучен сигнал SIGTERM, завершение работы...');
  mcpServer.kill('SIGTERM');
});
