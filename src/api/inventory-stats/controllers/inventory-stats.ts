/**
 * inventory-stats controller
 */

import type { Context } from 'koa';
import type { Core } from '@strapi/strapi';

const controller = ({ strapi }: { strapi: Core.Strapi }) => ({
  async stats(_ctx: Context) {
    const knex = strapi.db.connection;

    const [totals] = await knex('items')
      .count({ totalItems: 'id' })
      .sum({ totalUnits: 'stock_qty' });

    const [lowStock] = await knex('items')
      .count({ lowStockItems: 'id' })
      .whereRaw('stock_qty <= min_threshold');

    const perCategory = (await knex('items')
      .leftJoin('items_category_lnk', 'items_category_lnk.item_id', 'items.id')
      .leftJoin('categories', 'categories.id', 'items_category_lnk.category_id')
      .select('categories.name')
      .count({ count: 'items.id' })
      .groupBy('categories.name')) as unknown as {
      name: string | null;
      count: string | number;
    }[];

    const itemsPerCategory: Record<string, number> = {};
    for (const row of perCategory) {
      itemsPerCategory[row.name ?? 'Uncategorized'] = Number(row.count);
    }

    return {
      totalItems: Number(totals.totalItems ?? 0),
      totalUnits: Number(totals.totalUnits ?? 0),
      lowStockItems: Number(lowStock.lowStockItems ?? 0),
      itemsPerCategory,
    };
  },
});

export default controller;
