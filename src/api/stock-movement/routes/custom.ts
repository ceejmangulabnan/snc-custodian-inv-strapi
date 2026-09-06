/**
 * stock-movement custom router
 */

export default {
  type: "content-api" as const,
  routes: [
    {
      method: "POST",
      path: "/stock-movements/in",
      handler: "api::stock-movement.custom-stock-movement.stockIn",
      config: {
        auth: { scope: ["api::stock-movement.custom-stock-movement.stockIn"] },
        policies: [],
      },
    },
    {
      method: "POST",
      path: "/stock-movements/out",
      handler: "api::stock-movement.custom-stock-movement.stockOut",
      config: {
        auth: { scope: ["api::stock-movement.custom-stock-movement.stockOut"] },
        policies: [],
      },
    },
    {
      method: "POST",
      path: "/stock-movements/adjust",
      handler: "api::stock-movement.custom-stock-movement.adjust",
      config: {
        auth: { scope: ["api::stock-movement.custom-stock-movement.adjust"] },
        policies: [],
      },
    },
  ],
};