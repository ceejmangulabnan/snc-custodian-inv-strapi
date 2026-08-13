/**
 * inventory-stats router
 */

export default {
  type: 'content-api' as const,
  routes: [
    {
      method: 'GET',
      path: '/inventory-stats',
      handler: 'inventory-stats.stats',
    },
  ],
};
