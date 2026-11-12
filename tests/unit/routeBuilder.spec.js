import { test } from "@japa/runner";
import { RouteBuilder } from "../../src/RouteBuilder.js";

function fakeRouter() {
  const calls = [];
  const router = {};

  for (const method of ["get", "post", "patch", "put", "delete"]) {
    router[method] = (uri, ...handlers) => {
      calls.push({ method, uri, handlers });
    };
  }

  return { router, calls };
}

function fullController() {
  const controller = {};

  for (const name of ["index", "create", "store", "show", "edit", "update", "replace", "destroy"]) {
    controller[name] = () => {
      return name;
    };
  }

  return controller;
}

function summary(calls) {
  return calls.map((call) => {
    return `${call.method.toUpperCase()} ${call.uri}`;
  });
}

test.group("RouteBuilder", () => {
  test("resource registers handlers in order with Laravel URIs", ({ expect }) => {
    const { router, calls } = fakeRouter();

    new RouteBuilder(router).resource("/x", fullController());

    expect(summary(calls)).toEqual([
      "GET /x",
      "GET /x/create",
      "POST /x",
      "GET /x/:id",
      "GET /x/:id/edit",
      "PATCH /x/:id",
      "PUT /x/:id",
      "DELETE /x/:id",
    ]);
  });

  test("apiResource omits create and edit", ({ expect }) => {
    const { router, calls } = fakeRouter();

    new RouteBuilder(router).apiResource("/x", fullController());

    expect(summary(calls)).toEqual([
      "GET /x",
      "POST /x",
      "GET /x/:id",
      "PATCH /x/:id",
      "PUT /x/:id",
      "DELETE /x/:id",
    ]);
  });

  test("include and exclude filter the handlers", ({ expect }) => {
    const first = fakeRouter();
    new RouteBuilder(first.router).resource("/x", fullController(), { include: ["show", "index"] });
    expect(summary(first.calls)).toEqual(["GET /x", "GET /x/:id"]);

    const second = fakeRouter();
    new RouteBuilder(second.router).resource("/x", fullController(), { exclude: ["destroy"] });
    expect(summary(second.calls)).not.toContain("DELETE /x/:id");
    expect(second.calls).toHaveLength(7);
  });

  test("middleware runs before the handler", async ({ expect }) => {
    const { router, calls } = fakeRouter();
    const order = [];
    const mw1 = (req, res, next) => {
      order.push("mw1");
      next();
    };
    const mw2 = async (req, res, next) => {
      order.push("mw2");
      next();
    };
    const controller = {
      index: () => {
        order.push("index");
      },
    };

    new RouteBuilder(router).resource("/x", controller, {
      include: ["index"],
      middleware: [mw1, mw2],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].handlers).toHaveLength(3);

    for (const handler of calls[0].handlers) {
      await handler({}, {}, () => {});
    }

    expect(order).toEqual(["mw1", "mw2", "index"]);
  });

  test("a missing controller method names the URI", ({ expect }) => {
    const { router } = fakeRouter();

    expect(() => {
      return new RouteBuilder(router).resource("/x", {});
    }).toThrow(/\/x/);
  });

  test("an unknown handler name is rejected", ({ expect }) => {
    const { router } = fakeRouter();

    expect(() => {
      return new RouteBuilder(router).resource("/x", fullController(), { include: ["nope"] });
    }).toThrow(/nope/);
  });
});
