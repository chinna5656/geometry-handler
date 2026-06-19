import { useMemo, useState } from "react";

import { scoreCropAnomaly } from "../lib/api.js";

function defaultDateRange() {
  const end = new Date();
  const start = new Date(end);
  start.setFullYear(end.getFullYear() - 1);

  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10)
  };
}

export function AlertPanel({ polygon }) {
  const defaults = useMemo(defaultDateRange, []);
  const [isOpen, setIsOpen] = useState(true);
  const [startDate, setStartDate] = useState(defaults.startDate);
  const [endDate, setEndDate] = useState(defaults.endDate);
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState("Draw a plot and run the anomaly model.");
  const [isLoading, setIsLoading] = useState(false);

  async function handleScore() {
    if (!polygon) {
      setStatus("Draw a plot polygon first.");
      return;
    }

    setIsLoading(true);
    setStatus("Fusing NDVI, LST, and rainfall features.");
    try {
      const data = await scoreCropAnomaly({ polygon, startDate, endDate });
      setResult(data);
      setStatus(
        data.is_anomaly
          ? "Semi-abrupt statistical anomaly detected."
          : "Latest observation follows learned crop behavior."
      );
    } catch (error) {
      setResult(null);
      setStatus(error.message);
    } finally {
      setIsLoading(false);
    }
  }

  const critical = result?.is_anomaly;

  return (
    <section className="mt-5 border-t border-slate-200 pt-5">
      <button
        className="flex w-full items-center justify-between text-left"
        onClick={() => setIsOpen((value) => !value)}
        type="button"
      >
        <span>
          <span className="block text-sm font-semibold">Disease & Pest Early Warning</span>
          <span className="mt-1 block text-xs text-slate-500">Isolation Forest anomaly score</span>
        </span>
        <span className="text-lg text-slate-500">{isOpen ? "-" : "+"}</span>
      </button>

      {isOpen ? (
        <div className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs font-medium text-slate-600">
              Train from
              <input
                className="mt-1 w-full rounded border border-slate-300 px-2 py-2 text-sm"
                onChange={(event) => setStartDate(event.target.value)}
                type="date"
                value={startDate}
              />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Score through
              <input
                className="mt-1 w-full rounded border border-slate-300 px-2 py-2 text-sm"
                onChange={(event) => setEndDate(event.target.value)}
                type="date"
                value={endDate}
              />
            </label>
          </div>

          <button
            className="w-full rounded bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            disabled={!polygon || isLoading}
            onClick={handleScore}
            type="button"
          >
            {isLoading ? "Training iForest" : "Run Early Warning Model"}
          </button>

          {isLoading ? (
            <AlertSkeleton />
          ) : (
            <div className="rounded border border-slate-200 bg-slate-50 p-4">
              <div
                className={[
                  "rounded px-3 py-2 text-sm font-semibold",
                  critical
                    ? "animate-pulse bg-red-700 text-white"
                    : "bg-emerald-100 text-emerald-800"
                ].join(" ")}
              >
                {result
                  ? critical
                    ? "CRITICAL ANOMALY DETECTED"
                    : "Status: Normal"
                  : "Status: Not scored"}
              </div>

              {result ? (
                <div className="mt-4 space-y-3 text-sm">
                  <p className="text-slate-700">
                    {result.label}. Score: {result.anomaly_score.toFixed(4)}
                  </p>
                  <FeatureSummary features={result.latest_features} />
                  <ContributionList contributions={result.contributions} />
                </div>
              ) : null}
            </div>
          )}

          <p className="text-xs leading-5 text-slate-500">{status}</p>
        </div>
      ) : null}
    </section>
  );
}

function FeatureSummary({ features }) {
  return (
    <dl className="grid grid-cols-3 gap-2 text-xs">
      <div className="rounded bg-white p-2">
        <dt className="text-slate-500">NDVI</dt>
        <dd className="mt-1 font-semibold">{features.ndvi.toFixed(3)}</dd>
      </div>
      <div className="rounded bg-white p-2">
        <dt className="text-slate-500">LST</dt>
        <dd className="mt-1 font-semibold">{features.lst_celsius.toFixed(1)} C</dd>
      </div>
      <div className="rounded bg-white p-2">
        <dt className="text-slate-500">Rainfall</dt>
        <dd className="mt-1 font-semibold">{features.rainfall_mm.toFixed(1)} mm</dd>
      </div>
    </dl>
  );
}

function ContributionList({ contributions }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        Feature contribution breakdown
      </p>
      <ul className="mt-2 space-y-2">
        {contributions.map((item) => (
          <li className="rounded bg-white p-3 text-xs leading-5" key={item.feature}>
            <span className="font-semibold text-slate-800">{formatFeature(item.feature)}</span>
            <span className="text-slate-600">
              {" "}
              is {item.direction}: {item.value} vs baseline {item.baseline}. {item.message}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AlertSkeleton() {
  return (
    <div className="animate-pulse rounded border border-slate-200 bg-white p-4">
      <div className="h-8 rounded bg-slate-200" />
      <div className="mt-4 grid grid-cols-3 gap-2">
        <div className="h-14 rounded bg-slate-100" />
        <div className="h-14 rounded bg-slate-100" />
        <div className="h-14 rounded bg-slate-100" />
      </div>
      <div className="mt-4 space-y-2">
        <div className="h-4 rounded bg-slate-100" />
        <div className="h-4 w-5/6 rounded bg-slate-100" />
      </div>
    </div>
  );
}

function formatFeature(feature) {
  const labels = {
    ndvi: "NDVI",
    lst_celsius: "LST",
    rainfall_mm: "Cumulative rainfall"
  };
  return labels[feature] ?? feature;
}
