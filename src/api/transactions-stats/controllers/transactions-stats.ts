/**
 * transactions-stats controller
 */

import type { Context } from 'koa';
import type { Core } from '@strapi/strapi';

const controller = ({ strapi }: { strapi: Core.Strapi }) => ({
  async stats(_ctx: Context) {
    const knex = strapi.db.connection;

    const rows = (await knex('transactions')
      .select('order_status')
      .count({ count: 'id' })
      .groupBy('order_status')) as unknown as Array<{
      order_status: string | null;
      count: string | number;
    }>;

    const counts: Record<string, number> = {
      Pending: 0,
      Completed: 0,
      Voided: 0,
    };

    let total = 0;
    for (const row of rows) {
      const status = row.order_status ?? 'Pending';
      counts[status] = Number(row.count);
      total += Number(row.count);
    }

    return {
      total,
      pending: counts.Pending,
      completed: counts.Completed,
      voided: counts.Voided,
    };
  },
});

export default controller;
