import { test } from "@japa/runner";
import { paginate } from "../../app/http/support/pagination.js";

test.group("paginate", () => {
  test("a middle page links to its neighbours and keeps the other query parameters", ({
    expect,
  }) => {
    const result = paginate({
      page: 2,
      perPage: 10,
      total: 45,
      path: "/api/v1/sales",
      query: { status: "COMPLETED", page: "2", perPage: "10" },
    });

    expect(result.meta).toEqual({ page: 2, perPage: 10, total: 45, totalPages: 5 });
    expect(result.links).toEqual({
      self: "/api/v1/sales?status=COMPLETED&page=2&perPage=10",
      first: "/api/v1/sales?status=COMPLETED&page=1&perPage=10",
      prev: "/api/v1/sales?status=COMPLETED&page=1&perPage=10",
      next: "/api/v1/sales?status=COMPLETED&page=3&perPage=10",
      last: "/api/v1/sales?status=COMPLETED&page=5&perPage=10",
    });
    expect(result.prevUrl).toBe(result.links.prev);
    expect(result.nextUrl).toBe(result.links.next);
  });

  test("the first page has no previous link and the last page no next link", ({ expect }) => {
    const first = paginate({ page: 1, perPage: 10, total: 45, path: "/p" });
    const last = paginate({ page: 5, perPage: 10, total: 45, path: "/p" });

    expect([first.links.prev, first.prevUrl]).toEqual([null, null]);
    expect([last.links.next, last.nextUrl]).toEqual([null, null]);
  });

  test("an empty result is one page", ({ expect }) => {
    const result = paginate({ page: 1, perPage: 20, total: 0, path: "/p" });

    expect(result.meta.totalPages).toBe(1);
    expect(result.links.next).toBeNull();
    expect(result.pages).toEqual([{ number: 1, url: "/p?page=1&perPage=20", current: true }]);
  });

  test("a page beyond the end links back to the last real page", ({ expect }) => {
    const result = paginate({ page: 9, perPage: 10, total: 45, path: "/p" });

    expect(result.links.prev).toBe("/p?page=5&perPage=10");
    expect(result.links.next).toBeNull();
  });

  test("the page window shows up to five numbers around the current page", ({ expect }) => {
    const numbers = (page, total) => {
      return paginate({ page, perPage: 10, total, path: "/p" }).pages.map((entry) => {
        return entry.number;
      });
    };

    expect(numbers(1, 100)).toEqual([1, 2, 3, 4, 5]);
    expect(numbers(6, 100)).toEqual([4, 5, 6, 7, 8]);
    expect(numbers(10, 100)).toEqual([6, 7, 8, 9, 10]);
    expect(numbers(2, 30)).toEqual([1, 2, 3]);
    expect(paginate({ page: 6, perPage: 10, total: 100, path: "/p" }).pages[2].current).toBe(true);
  });

  test("empty and missing query values are dropped from links", ({ expect }) => {
    const result = paginate({
      page: 1,
      perPage: 10,
      total: 5,
      path: "/p",
      query: { q: "", status: undefined, from: "2026-11-01" },
    });

    expect(result.links.self).toBe("/p?from=2026-11-01&page=1&perPage=10");
  });
});
