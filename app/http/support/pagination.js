const WINDOW = 5;

/**
 * Page metadata, JSON:API-style links and a window of page numbers for the UI.
 * `query` is the request's query string as given; paging parameters and empty values are dropped
 * from the generated links and `page` and `perPage` are appended.
 */
export function paginate({ page, perPage, total, path, query = {} }) {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const kept = Object.entries(query).filter(([key, value]) => {
    return (
      key !== "page" && key !== "perPage" && value !== undefined && value !== null && value !== ""
    );
  });

  const url = (number) => {
    const params = new URLSearchParams();

    for (const [key, value] of kept) {
      params.set(key, String(value));
    }

    params.set("page", String(number));
    params.set("perPage", String(perPage));

    return `${path}?${params.toString()}`;
  };

  const prev = page > 1 ? url(Math.min(page - 1, totalPages)) : null;
  const next = page < totalPages ? url(page + 1) : null;
  const start = Math.max(1, Math.min(page - 2, totalPages - WINDOW + 1));
  const end = Math.min(totalPages, start + WINDOW - 1);
  const pages = [];

  for (let number = start; number <= end; number++) {
    pages.push({ number, url: url(number), current: number === page });
  }

  return {
    meta: { page, perPage, total, totalPages },
    links: { self: url(page), first: url(1), prev, next, last: url(totalPages) },
    prevUrl: prev,
    nextUrl: next,
    pages,
  };
}
