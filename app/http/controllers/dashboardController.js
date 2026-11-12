import { can, PERMISSIONS } from "../../services/auth/permissions.js";
import { getSummary, listSales } from "../../services/sales/salesQuery.js";
import { salesScope } from "../../services/sales/scope.js";
import { cmp, div, mul, sum, toScale } from "../../services/support/decimal.js";
import { addDays, businessDate } from "../../services/support/time.js";

const DAYS = 14;

const METHOD_LABELS = {
  CASH: "Cash",
  CARD: "Card",
  GCASH: "GCash",
  MAYA: "Maya",
  BANK_TRANSFER: "Bank transfer",
  OTHER: "Other",
};

// The axis maximum for a chart: the next "nice" number (1, 2, 2.5, 5 times a power of ten).
// Chart geometry is display only, so plain numbers are fine here; money in services stays decimal.
function niceCeiling(value) {
  if (!(value > 0)) {
    return 100;
  }

  const magnitude = 10 ** Math.floor(Math.log10(value));

  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * magnitude >= value) {
      return step * magnitude;
    }
  }

  return 10 * magnitude;
}

function tickLabel(value, compact) {
  if (compact) {
    return `₱${Number((value / 1000).toFixed(2))}K`;
  }

  return `₱${new Intl.NumberFormat("en-PH").format(value)}`;
}

function dayLabel(date) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// Everything the template prints exists in every case (strict mode), empty when there is no data.
function emptyView(user) {
  return {
    hasAccess: can(user, PERMISSIONS.DASHBOARD_VIEW),
    hasSalesData: false,
    canSell: can(user, PERMISSIONS.SALES_CREATE),
    canManageRegister: can(user, PERMISSIONS.REGISTER_MANAGE),
    today: { salesCount: 0, grossSales: "0.00", yesterdayGross: "0.00" },
    fortnight: { salesCount: 0, grossSales: "0.00", averageSale: "0.00" },
    daily: [],
    yTicks: [],
    peak: null,
    paymentMix: [],
    recentSales: [],
    openSession: null,
  };
}

export default {
  index: async (req, res) => {
    const view = emptyView(req.user);

    if (!view.hasAccess || salesScope(req.user).level === "none") {
      return res.render("dashboard", { pageTitle: "Dashboard", layout: "authenticated", ...view });
    }

    const today = businessDate(new Date());
    const summary = await getSummary({ from: addDays(today, 1 - DAYS), to: today }, req.user);
    const { rows: recentSales } = await listSales(
      { page: 1, perPage: 10, sort: "-transactionDate" },
      req.user,
    );

    const highest = summary.byDay.reduce((best, day) => {
      return cmp(day.grossSales, best) > 0 ? day.grossSales : best;
    }, "0.00");
    const axisMax = niceCeiling(Number(highest));
    const compact = axisMax >= 10_000;
    const daily = summary.byDay.map((day) => {
      const share = Math.round((Number(day.grossSales) / axisMax) * 100);

      return {
        date: day.date,
        label: dayLabel(day.date),
        day: String(Number(day.date.slice(8))),
        salesCount: day.salesCount,
        grossSales: day.grossSales,
        // a day with any sales keeps a visible sliver
        heightPct: cmp(day.grossSales, "0") > 0 ? Math.max(2, share) : 0,
        isToday: day.date === today,
      };
    });
    const peakDay = daily.find((day) => {
      return day.grossSales === highest && cmp(highest, "0") > 0;
    });
    const mixTotal = sum(
      summary.byPaymentMethod.map((method) => {
        return method.amount;
      }),
    );
    const mixMax = summary.byPaymentMethod.reduce((best, method) => {
      return cmp(method.amount, best) > 0 ? method.amount : best;
    }, "0.00");
    const last = summary.byDay[summary.byDay.length - 1];
    const previous = summary.byDay[summary.byDay.length - 2];

    return res.render("dashboard", {
      pageTitle: "Dashboard",
      layout: "authenticated",
      ...view,
      hasSalesData: true,
      today: {
        salesCount: last.salesCount,
        grossSales: last.grossSales,
        yesterdayGross: previous ? previous.grossSales : "0.00",
      },
      fortnight: {
        salesCount: summary.totals.salesCount,
        grossSales: summary.totals.grossSales,
        averageSale: summary.totals.averageSale,
      },
      daily,
      yTicks: [0, axisMax / 2, axisMax].map((value, index) => {
        return { label: tickLabel(value, compact), pct: index * 50, isBase: index === 0 };
      }),
      peak: peakDay ? { label: peakDay.label, grossSales: peakDay.grossSales } : null,
      paymentMix: summary.byPaymentMethod
        .filter((method) => {
          return cmp(method.amount, "0") > 0;
        })
        .map((method) => {
          return {
            label: METHOD_LABELS[method.method] ?? method.method,
            amount: method.amount,
            pct: Number(toScale(mul(div(method.amount, mixTotal, 4), "100"), 0)),
            barPct: Number(toScale(mul(div(method.amount, mixMax, 4), "100"), 0)),
          };
        }),
      recentSales,
    });
  },
};
