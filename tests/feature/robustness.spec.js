import { test } from "@japa/runner";
import { ROLE_PERMISSIONS } from "../../app/services/auth/permissions.js";
import { resetDatabase } from "../helpers/db.js";
import { makeUser, makeWorld } from "../helpers/factories.js";
import { loginAs, TestSession } from "../helpers/http.js";

const PAGES = [
  "/sales",
  "/inventory",
  "/inventory/batches",
  "/products",
  "/stock-counts",
  "/purchase-orders",
  "/suppliers",
  "/returns",
  "/transfers",
  "/prescriptions",
  "/purchase-returns",
  "/audit",
  "/reports/movements",
  "/users",
  "/dashboard-page",
  "/api/v1/sales",
  "/api/v1/products",
  "/api/v1/sales/summary",
];

const QUERIES = [
  "page=0",
  "page=100000000000000000000",
  "page=1e9",
  "page[]=1",
  "page[a]=1",
  "q=%25",
  "q[]=a",
  "q=%00",
  "status=zzz",
  "status[]=DRAFT",
  "from=2026-02-31",
  "from=2026-12-31&to=2026-01-01",
  "branchId=not-a-uuid",
  "perPage=100000",
  "sort[]=x",
  "limit=9999999",
];
const LONG_QUERY = `q=${"a".repeat(5000)}`;

test("no list page crashes on hostile query strings", async ({ expect }) => {
  await resetDatabase();

  const world = await makeWorld();
  const admin = await loginAs(
    await makeUser({
      branchId: world.branch.id,
      roleName: "fuzz-admin",
      permissions: ROLE_PERMISSIONS.admin,
    }),
  );
  const crashes = [];

  for (const page of PAGES) {
    const accept = page.startsWith("/api") ? "application/json" : "text/html";

    for (const query of [...QUERIES, LONG_QUERY]) {
      const response = await admin.get(`${page}?${query}`, { headers: { accept } });

      if (response.status >= 500) {
        crashes.push(`${response.status} ${page}?${query.slice(0, 60)}`);
      }
    }
  }

  expect(crashes).toEqual([]);
});

test("detail pages and actions survive malformed ids", async ({ expect }) => {
  await resetDatabase();

  const world = await makeWorld();
  const admin = await loginAs(
    await makeUser({
      branchId: world.branch.id,
      roleName: "fuzz-admin-2",
      permissions: ROLE_PERMISSIONS.admin,
    }),
  );
  const ids = ["x", "%00", "00000000-0000-4000-8000-000000000000", "a".repeat(300)];
  const bases = [
    "/sales",
    "/products/{id}/edit",
    "/stock-counts",
    "/purchase-orders",
    "/purchase-orders/{id}/edit",
    "/purchase-orders/{id}/receive",
    "/suppliers/{id}/edit",
    "/returns",
    "/transfers",
    "/prescriptions",
    "/purchase-returns",
    "/sales/{id}/return",
    "/inventory/batches",
  ];
  const crashes = [];

  for (const base of bases) {
    for (const id of ids) {
      const path = base.includes("{id}") ? base.replace("{id}", id) : `${base}/${id}`;
      const get = await admin.get(path, { headers: { accept: "text/html" } });

      if (get.status >= 500) {
        crashes.push(`GET ${get.status} ${path.slice(0, 80)}`);
      }
    }
  }

  for (const action of ["submit", "approve", "post", "cancel", "process", "receive", "verify"]) {
    for (const base of [
      "/stock-counts",
      "/returns",
      "/transfers",
      "/prescriptions",
      "/purchase-returns",
      "/purchase-orders",
    ]) {
      for (const id of ids) {
        const response = await admin.post(`${base}/${id}/${action}`, {
          headers: { accept: "text/html" },
          form: { reason: "x" },
        });

        if (response.status >= 500) {
          crashes.push(`POST ${response.status} ${base}/${id.slice(0, 20)}/${action}`);
        }
      }
    }
  }

  expect(crashes).toEqual([]);
});

test("create endpoints survive hostile bodies", async ({ expect }) => {
  await resetDatabase();

  const world = await makeWorld();
  const admin = await loginAs(
    await makeUser({
      branchId: world.branch.id,
      roleName: "fuzz-admin-3",
      permissions: ROLE_PERMISSIONS.admin,
    }),
  );
  const forms = [
    {},
    { lines: "abc" },
    { "lines[0]": "x" },
    { "lines[0][a]": "x", "lines[999999][b]": "y" },
    { "lines[0][quantity]": "1e999", "lines[0][inventoryBatchId]": "%00" },
    { "lines[][x]": "1" },
    { "a[b][c][d][e][f][g][h]": "deep" },
    { reason: "r".repeat(100000) },
    { name: "n".repeat(100000), sku: "s".repeat(1000) },
    { "items[0][sku]": "x", "items[0][prescribedQuantity]": "abc", physicianName: "\u0000" },
    { sourceBranchId: "x", "lines[0][sourceBatchId]": "y" },
    { supplierId: "x", "lines[0][inventoryBatchId]": "y" },
    { email: "a@b.c", password: "p", name: "n", branchId: "zz", roles: "x", "roles[]": "y" },
  ];
  const paths = [
    "/products",
    "/suppliers",
    "/purchase-orders",
    "/stock-counts",
    "/sales/00000000-0000-4000-8000-000000000000/returns",
    "/transfers",
    "/prescriptions",
    "/purchase-returns",
    "/users",
    "/register",
    "/login",
  ];
  const crashes = [];

  for (const path of paths) {
    for (const form of forms) {
      const response = await admin.post(path, { headers: { accept: "text/html" }, form });

      if (response.status >= 500) {
        crashes.push(`${response.status} ${path} ${JSON.stringify(form).slice(0, 70)}`);
      }
    }
  }

  const jsons = [
    [],
    "text",
    null,
    { items: "x", payments: [] },
    { items: [null], payments: [null] },
    { items: [{ productUnitId: 5, quantity: {} }], payments: [{ method: [], amount: -1 }] },
    {
      items: Array.from({ length: 500 }, () => {
        return { productUnitId: "00000000-0000-4000-8000-000000000000", quantity: "1" };
      }),
      payments: [],
    },
    { items: [], payments: [], prescriptionId: 5, customerId: "x" },
    { __proto__: { admin: true }, items: [], payments: [] },
  ];

  for (const json of jsons) {
    const response = await admin.post("/api/v1/sales", {
      headers: {
        accept: "application/json",
        "idempotency-key": "00000000-0000-4000-8000-000000000001",
      },
      json,
    });

    if (response.status >= 500) {
      crashes.push(`${response.status} POST /api/v1/sales ${JSON.stringify(json)?.slice(0, 60)}`);
    }
  }

  expect(crashes).toEqual([]);
});

test("client errors from the parsers are 4xx, not 500", async ({ expect }) => {
  const session = new TestSession();
  const html = { accept: "text/html" };
  const badPath = await session.get("/sales/%E0%A4%A", { headers: html });
  const tooBig = await session.post("/login", {
    headers: html,
    form: { email: "a@b.c", password: "x".repeat(2_000_000) },
  });
  const charset = await session.request("POST", "/login", {
    headers: { ...html, "content-type": "application/x-www-form-urlencoded; charset=latin1" },
    body: "email=a",
  });

  expect([badPath.status, tooBig.status, charset.status]).toEqual([400, 413, 415]);
});

test("anonymous requests do not start sessions", async ({ expect }) => {
  for (const path of ["/api/v1/up", "/login-page", "/"]) {
    const response = await new TestSession().get(path, { headers: { accept: "text/html" } });

    expect([path, response.headers.get("set-cookie")]).toEqual([path, null]);
  }
});
