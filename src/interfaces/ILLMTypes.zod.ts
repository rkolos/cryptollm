import { z } from 'zod';

// Helper для преобразования null в undefined для optional полей
const nullToUndefined = <T extends z.ZodTypeAny>(schema: T) => {
  return z.preprocess((val) => (val === null ? undefined : val), schema);
};

const parametersSchema = z
  .object({
    type: z.enum(['market', 'limit']).optional(),
    price: nullToUndefined(z.number().optional()),
    risk_percent: z.number().optional().nullable(),
    stop_loss_price: z.number().optional().nullable(),
    take_profit_price: z.number().optional().nullable(),
    trailing_stop_config: z
      .object({
        type: z.literal('percentage'),
        distance: z.number(),
      })
      .nullable()
      .optional(),
    amount_percent: nullToUndefined(z.number().optional()),
    order_id: z.string().nullable().optional(),
    new_stop_loss_price: nullToUndefined(z.number().optional()),
    new_take_profit_price: nullToUndefined(z.number().optional()),
    new_trailing_stop_config: z
      .object({
        type: z.literal('percentage'),
        distance: z.number(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

const decisionSchema = z.object({
  action: z.enum(['OPEN_LONG', 'OPEN_SHORT', 'CLOSE_POSITION', 'MODIFY_POSITION', 'CANCEL_ORDERS', 'HOLD']),
  pair: z.string(),
  parameters: parametersSchema,
  justification: z.string(),
});

const triggerSchema = z.object({
  type: z.enum(['price', 'indicator', 'timeout']),
  condition: z.string(),
  value: z.number(), // Обязательное поле - не может быть null
  name: nullToUndefined(z.string().optional()),
  timeframe: nullToUndefined(z.string().optional()),
});

export const llmResponseSchema = z.object({
  decisions: z.array(decisionSchema),
  update_triggers_for_pair: z.string(),
  next_call_triggers: z.object({
    reason: z.string(),
    trigger_conditions: z.array(triggerSchema),
  }),
  request_additional_data: z.array(z.string()).nullable(),
});
