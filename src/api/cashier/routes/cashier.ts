/**
 * cashier router
 */

export default {
  type: "content-api" as const,
  routes: [
    {
      method: "GET",
      path: "/cashier/items",
      handler: "api::cashier.cashier.find",
      config: {
        auth: { scope: ["api::cashier.cashier.find"] },
        policies: [],
      },
    },
    {
      method: "POST",
      path: "/cashier/issue",
      handler: "api::cashier.cashier.issue",
      config: {
        auth: { scope: ["api::cashier.cashier.issue"] },
        policies: [],
      },
    },
  ],
};