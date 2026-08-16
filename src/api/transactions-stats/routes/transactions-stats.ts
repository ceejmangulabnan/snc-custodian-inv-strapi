/**
 * transactions-stats router
 */

export default {
  type: 'content-api' as const,
  routes: [
    {
      method: 'GET',
      path: '/transactions-stats',
      handler: 'transactions-stats.stats',
    },
  ],
};
