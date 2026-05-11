import { describe, expect, it } from "vitest";
import { evaluate, type DataReadiness } from "./rules";
import type { Campaign, DailyMetric, RulesConfig } from "@/types/domain";

// Minimal rules config with strict thresholds so a single bad day triggers Regra 1.
const baseRules: RulesConfig = {
  user_id: "test",
  min_roi_pct: 10,
  max_loss_roi_pct: -20,
  boost_roi_pct: 40,
  analysis_days: 1,
  min_spend_threshold: 10,
  auto_pause_enabled: false,
  auto_boost_enabled: false,
  budget_increase_pct: 20,
  auto_analysis_days: 15,
  auto_stoploss_days: 7,
  auto_stoploss_min_roi: -20,
  auto_stoploss_min_cost: 0,
  auto_scale_min_roi: 30,
  auto_scale_budget_pct: 20,
  auto_scale_interval_days: 3,
  auto_cpa_up_pct: 10,
  auto_cpa_down_pct: 10,
  auto_cpa_review_days: 3,
  auto_standby_enter_days: 7,
  auto_standby_max_days: 14,
  auto_standby_roi_low: 1,
  auto_standby_roi_high: 10,
  auto_standby_exit_roi: 10,
};

const campaign = (id: string, name = id): Campaign => ({
  id: `pk-${id}`,
  user_id: "user-1",
  campaign_id: id,
  name,
  status: "ENABLED",
  google_account_id: "acc-1",
  channel_type: "SEARCH",
  budget_micros: null,
  target_cpa_micros: null,
});

const metric = (
  id: string,
  overrides: Partial<DailyMetric> = {},
  date = "2026-05-10",
): DailyMetric => ({
  id: `m-${id}-${date}`,
  user_id: "user-1",
  campaign_id: id,
  google_account_id: "acc-1",
  date,
  spend: 0,
  clicks: 0,
  conversions: 0,
  impressions: 0,
  revenue: 0,
  profit: 0,
  roi: 0,
  roas: 0,
  ecpm: 0,
  ...overrides,
});

// Spend $100, no revenue — the exact pattern that produced false -100% alerts
// when GAM hadn't returned data yet.
const metricSpendOnly = (id: string, date = "2026-05-10"): DailyMetric =>
  metric(id, { spend: 100, revenue: 0, profit: -100, clicks: 50, impressions: 1000 }, date);

// Spend $100, real revenue $20 → genuinely bad campaign, alert should still fire.
const metricGenuineLoss = (id: string, date = "2026-05-10"): DailyMetric =>
  metric(id, { spend: 100, revenue: 20, profit: -80, clicks: 50, conversions: 1, impressions: 1000 }, date);

describe("evaluate — data readiness gate", () => {
  it("fires the critical alert when readiness is not provided (legacy behavior preserved)", () => {
    const out = evaluate({
      campaigns: [campaign("c1")],
      metrics: [metricSpendOnly("c1")],
      placements: [],
      rules: baseRules,
    });
    const critical = out.alerts.filter((a) => a.severity === "critical");
    expect(critical).toHaveLength(1);
    expect(critical[0].category).toBe("bad_campaign");
  });

  it("fires the critical alert when readiness is ready", () => {
    const readiness: DataReadiness = { isReady: true, gamMinutesSinceSuccess: 5 };
    const out = evaluate({
      campaigns: [campaign("c1")],
      metrics: [metricSpendOnly("c1")],
      placements: [],
      rules: baseRules,
      dataReadiness: readiness,
    });
    const critical = out.alerts.filter((a) => a.severity === "critical");
    expect(critical).toHaveLength(1);
  });

  it("suppresses the critical alert when GAM is stale AND revenue is zero", () => {
    const readiness: DataReadiness = {
      isReady: false,
      reason: "gam_stale",
      gamMinutesSinceSuccess: 480,
    };
    const out = evaluate({
      campaigns: [campaign("c1")],
      metrics: [metricSpendOnly("c1")],
      placements: [],
      rules: baseRules,
      dataReadiness: readiness,
    });
    const critical = out.alerts.filter((a) => a.severity === "critical");
    expect(critical).toHaveLength(0);

    // A single info notice replaces the suppressed alert.
    const info = out.alerts.filter((a) => a.severity === "info");
    expect(info).toHaveLength(1);
    expect(info[0].title).toContain("Aguardando dados");
    expect(info[0].metric_snapshot?.suppressed_count).toBe(1);
  });

  it("still fires the critical alert when GAM is stale BUT revenue is non-zero", () => {
    // If revenue is actually present, the -100% case doesn't apply; the campaign
    // is genuinely losing money and the alert is informative, not a false positive.
    const readiness: DataReadiness = {
      isReady: false,
      reason: "gam_stale",
      gamMinutesSinceSuccess: 480,
    };
    const out = evaluate({
      campaigns: [campaign("c1")],
      metrics: [metricGenuineLoss("c1")],
      placements: [],
      rules: baseRules,
      dataReadiness: readiness,
    });
    const critical = out.alerts.filter((a) => a.severity === "critical");
    expect(critical).toHaveLength(1);
  });

  it("groups multiple suppressed alerts into a single info notice", () => {
    const readiness: DataReadiness = {
      isReady: false,
      reason: "gam_stale",
      gamMinutesSinceSuccess: 90,
    };
    const out = evaluate({
      campaigns: [campaign("c1"), campaign("c2"), campaign("c3")],
      metrics: [
        metricSpendOnly("c1"),
        metricSpendOnly("c2"),
        metricSpendOnly("c3"),
      ],
      placements: [],
      rules: baseRules,
      dataReadiness: readiness,
    });
    const critical = out.alerts.filter((a) => a.severity === "critical");
    const info = out.alerts.filter((a) => a.severity === "info");
    expect(critical).toHaveLength(0);
    expect(info).toHaveLength(1);
    expect(info[0].metric_snapshot?.suppressed_count).toBe(3);
  });
});
