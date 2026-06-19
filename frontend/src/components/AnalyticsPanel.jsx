import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";

import { fetchNdviTimeSeries } from "../lib/api.js";

function defaultDateRange() {
  const end = new Date();
  const start = new Date(end);
  start.setMonth(end.getMonth() - 6);

  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10)
  };
}

export function AnalyticsPanel({ polygon }) {
  const defaults = useMemo(defaultDateRange, []);
  const [isOpen, setIsOpen] = useState(true);
  const [startDate, setStartDate] = useState(defaults.startDate);
  const [endDate, setEndDate] = useState(defaults.endDate);
  const [points, setPoints] = useState([]);
  const [status, setStatus] = useState("Draw a plot to analyze historical growth.");
  const [isLoading, setIsLoading] = useState(false);

  async function handleLoadSeries() {
    if (!polygon) {
      setStatus("Draw a plot polygon first.");
      return;
    }

    setIsLoading(true);
    setStatus("Aggregating Sentinel-2 NDVI by date.");
    try {
      const data = await fetchNdviTimeSeries({ polygon, startDate, endDate });
      setPoints(data.points);
      setStatus(
        data.points.length
          ? `Loaded ${data.points.length} NDVI observations.`
          : "No cloud-free observations found for this period."
      );
    } catch (error) {
      setStatus(error.message);
      setPoints([]);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <section className="mt-5 border-t border-slate-200 pt-5">
      <button
        className="flex w-full items-center justify-between text-left"
        onClick={() => setIsOpen((value) => !value)}
        type="button"
      >
        <span>
          <span className="block text-sm font-semibold">Historical Analytics</span>
          <span className="mt-1 block text-xs text-slate-500">NDVI phenology curve</span>
        </span>
        <span className="text-lg text-slate-500">{isOpen ? "-" : "+"}</span>
      </button>

      {isOpen ? (
        <div className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs font-medium text-slate-600">
              Start date
              <input
                className="mt-1 w-full rounded border border-slate-300 px-2 py-2 text-sm"
                onChange={(event) => setStartDate(event.target.value)}
                type="date"
                value={startDate}
              />
            </label>
            <label className="text-xs font-medium text-slate-600">
              End date
              <input
                className="mt-1 w-full rounded border border-slate-300 px-2 py-2 text-sm"
                onChange={(event) => setEndDate(event.target.value)}
                type="date"
                value={endDate}
              />
            </label>
          </div>

          <button
            className="w-full rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            disabled={!polygon || isLoading}
            onClick={handleLoadSeries}
            type="button"
          >
            {isLoading ? "Processing Time Series" : "Load Growth Curve"}
          </button>

          {isLoading ? <ChartSkeleton /> : <NdviChart points={points} />}

          <p className="text-xs leading-5 text-slate-500">{status}</p>
        </div>
      ) : null}
    </section>
  );
}

function NdviChart({ points }) {
  if (!points.length) {
    return (
      <div className="flex h-56 items-center justify-center rounded border border-dashed border-slate-300 bg-slate-50 text-sm text-slate-500">
        No NDVI time series loaded.
      </div>
    );
  }

  return (
    <div className="h-64 rounded border border-slate-200 bg-white p-3">
      <ResponsiveContainer height="100%" width="100%">
        <LineChart data={points} margin={{ top: 8, right: 12, left: -20, bottom: 8 }}>
          <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" />
          <XAxis dataKey="date" fontSize={11} minTickGap={18} />
          <YAxis
            domain={[0, 1]}
            fontSize={11}
            tickFormatter={(value) => value.toFixed(1)}
          />
          <Tooltip
            formatter={(value) => [Number(value).toFixed(3), "Mean NDVI"]}
            labelFormatter={(label) => `Date: ${label}`}
          />
          <Line
            dataKey="mean_ndvi"
            dot={{ r: 3 }}
            isAnimationActive={false}
            name="Mean NDVI"
            stroke="#047857"
            strokeWidth={3}
            type="monotone"
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function ChartSkeleton() {
  return (
    <div className="h-64 animate-pulse rounded border border-slate-200 bg-white p-4">
      <div className="h-4 w-32 rounded bg-slate-200" />
      <div className="mt-8 space-y-5">
        <div className="h-3 w-full rounded bg-slate-200" />
        <div className="h-3 w-5/6 rounded bg-slate-200" />
        <div className="h-3 w-3/4 rounded bg-slate-200" />
        <div className="h-3 w-11/12 rounded bg-slate-200" />
      </div>
      <div className="mt-8 h-20 rounded bg-gradient-to-r from-slate-100 via-slate-200 to-slate-100" />
    </div>
  );
}
