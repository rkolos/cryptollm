#!/usr/bin/env tsx
/**
 * Скрипт для получения TELEGRAM_CHAT_ID из группы
 *
 * Инструкция:
 * 1. Убедитесь, что бот добавлен в группу и является админом
 * 2. Отправьте любое сообщение в группу (например, "test")
 * 3. Запустите этот скрипт: npm run get-chat-id
 * 4. Скрипт покажет chat_id группы
 */

const BOT_TOKEN = '8370816426:AAE2bx0v5mUHWopxzfNuoZBT1hqw4vrqs4E';
const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function getChatId(): Promise<void> {
  console.log('Получение обновлений от Telegram бота...');
  console.log('Убедитесь, что вы отправили сообщение в группу после добавления бота.\n');

  try {
    const response = await fetch(`${API_URL}/getUpdates`);
    const data = await response.json();

    if (!data.ok) {
      console.error('Ошибка API:', data.description);
      process.exit(1);
    }

    const updates = data.result;

    if (updates.length === 0) {
      console.log('❌ Обновлений не найдено.');
      console.log('\n📝 Инструкция:');
      console.log('1. Откройте группу в Telegram');
      console.log('2. Отправьте любое сообщение в группу (например, "test")');
      console.log('3. Запустите этот скрипт снова: npm run get-chat-id');
      process.exit(0);
    }

    // Ищем chat_id в последних обновлениях
    const chatIds = new Set<number>();

    for (const update of updates) {
      if (update.message?.chat) {
        const chat = update.message.chat;
        if (chat.type === 'group' || chat.type === 'supergroup') {
          chatIds.add(chat.id);
          console.log(`\n✅ Найден chat_id группы:`);
          console.log(`   Chat ID: ${chat.id}`);
          console.log(`   Название группы: ${chat.title || 'N/A'}`);
          console.log(`   Тип: ${chat.type}`);
          console.log(`   Username: ${chat.username || 'N/A'}`);
        }
      }
    }

    if (chatIds.size === 0) {
      console.log('❌ Не найдено групповых чатов в обновлениях.');
      console.log('Убедитесь, что сообщение было отправлено в группу, а не в личные сообщения боту.');
    } else {
      console.log(`\n📋 Используйте один из этих chat_id в .env:`);
      chatIds.forEach((id) => {
        console.log(`   TELEGRAM_CHAT_ID=${id}`);
      });
    }
  } catch (error) {
    console.error('Ошибка при получении обновлений:', error);
    process.exit(1);
  }
}

getChatId();
