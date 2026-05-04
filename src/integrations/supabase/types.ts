export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      account_site_links: {
        Row: {
          created_at: string
          google_account_id: string
          id: string
          site_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          google_account_id: string
          id?: string
          site_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          google_account_id?: string
          id?: string
          site_id?: string
          user_id?: string
        }
        Relationships: []
      }
      ads_placements: {
        Row: {
          ad_group_id: string | null
          ad_group_name: string | null
          avg_cpc: number
          campaign_id: string
          campaign_name: string | null
          clicks: number
          conversions: number
          cost: number
          created_at: string
          ctr: number
          date: string
          display_name: string | null
          google_account_id: string | null
          id: string
          impressions: number
          placement: string
          placement_clean: string | null
          placement_type: string | null
          target_url: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          ad_group_id?: string | null
          ad_group_name?: string | null
          avg_cpc?: number
          campaign_id: string
          campaign_name?: string | null
          clicks?: number
          conversions?: number
          cost?: number
          created_at?: string
          ctr?: number
          date: string
          display_name?: string | null
          google_account_id?: string | null
          id?: string
          impressions?: number
          placement: string
          placement_clean?: string | null
          placement_type?: string | null
          target_url?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          ad_group_id?: string | null
          ad_group_name?: string | null
          avg_cpc?: number
          campaign_id?: string
          campaign_name?: string | null
          clicks?: number
          conversions?: number
          cost?: number
          created_at?: string
          ctr?: number
          date?: string
          display_name?: string | null
          google_account_id?: string | null
          id?: string
          impressions?: number
          placement?: string
          placement_clean?: string | null
          placement_type?: string | null
          target_url?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      alerts: {
        Row: {
          acknowledged: boolean
          campaign_id: string | null
          category: string
          created_at: string
          id: string
          message: string | null
          metric_snapshot: Json | null
          placement_key: string | null
          severity: string
          title: string
          user_id: string
        }
        Insert: {
          acknowledged?: boolean
          campaign_id?: string | null
          category: string
          created_at?: string
          id?: string
          message?: string | null
          metric_snapshot?: Json | null
          placement_key?: string | null
          severity?: string
          title: string
          user_id: string
        }
        Update: {
          acknowledged?: boolean
          campaign_id?: string | null
          category?: string
          created_at?: string
          id?: string
          message?: string | null
          metric_snapshot?: Json | null
          placement_key?: string | null
          severity?: string
          title?: string
          user_id?: string
        }
        Relationships: []
      }
      automation_actions: {
        Row: {
          action_type: string
          campaign_id: string
          created_at: string
          error: string | null
          executed_at: string | null
          id: string
          payload: Json | null
          reason: string | null
          status: string
          user_id: string
        }
        Insert: {
          action_type: string
          campaign_id: string
          created_at?: string
          error?: string | null
          executed_at?: string | null
          id?: string
          payload?: Json | null
          reason?: string | null
          status?: string
          user_id: string
        }
        Update: {
          action_type?: string
          campaign_id?: string
          created_at?: string
          error?: string | null
          executed_at?: string | null
          id?: string
          payload?: Json | null
          reason?: string | null
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      automation_logs: {
        Row: {
          action: string
          campaign_id: string
          cost: number | null
          created_at: string
          decision: string | null
          error: string | null
          google_account_id: string | null
          id: string
          lifecycle_from: string | null
          lifecycle_to: string | null
          payload: Json | null
          reason: string | null
          revenue: number | null
          roi: number | null
          site_id: string | null
          user_id: string
        }
        Insert: {
          action: string
          campaign_id: string
          cost?: number | null
          created_at?: string
          decision?: string | null
          error?: string | null
          google_account_id?: string | null
          id?: string
          lifecycle_from?: string | null
          lifecycle_to?: string | null
          payload?: Json | null
          reason?: string | null
          revenue?: number | null
          roi?: number | null
          site_id?: string | null
          user_id: string
        }
        Update: {
          action?: string
          campaign_id?: string
          cost?: number | null
          created_at?: string
          decision?: string | null
          error?: string | null
          google_account_id?: string | null
          id?: string
          lifecycle_from?: string | null
          lifecycle_to?: string | null
          payload?: Json | null
          reason?: string | null
          revenue?: number | null
          roi?: number | null
          site_id?: string | null
          user_id?: string
        }
        Relationships: []
      }
      campaign_automation: {
        Row: {
          campaign_id: string
          cooldown_until: string | null
          created_at: string
          daily_budget: number | null
          days_in_standby: number
          delivery_ratio: number | null
          entered_standby_at: string | null
          google_account_id: string | null
          id: string
          last_action: string | null
          last_action_date: string | null
          last_cpa_action: string | null
          last_cpa_action_date: string | null
          last_delivery_action: string | null
          last_delivery_action_date: string | null
          last_evaluated_at: string
          last_roi: number | null
          last_scale_date: string | null
          lifecycle_status: string
          roi_trend: string | null
          site_id: string | null
          updated_at: string
          user_id: string
          winner_country_code: string | null
          winner_started_at: string | null
        }
        Insert: {
          campaign_id: string
          cooldown_until?: string | null
          created_at?: string
          daily_budget?: number | null
          days_in_standby?: number
          delivery_ratio?: number | null
          entered_standby_at?: string | null
          google_account_id?: string | null
          id?: string
          last_action?: string | null
          last_action_date?: string | null
          last_cpa_action?: string | null
          last_cpa_action_date?: string | null
          last_delivery_action?: string | null
          last_delivery_action_date?: string | null
          last_evaluated_at?: string
          last_roi?: number | null
          last_scale_date?: string | null
          lifecycle_status?: string
          roi_trend?: string | null
          site_id?: string | null
          updated_at?: string
          user_id: string
          winner_country_code?: string | null
          winner_started_at?: string | null
        }
        Update: {
          campaign_id?: string
          cooldown_until?: string | null
          created_at?: string
          daily_budget?: number | null
          days_in_standby?: number
          delivery_ratio?: number | null
          entered_standby_at?: string | null
          google_account_id?: string | null
          id?: string
          last_action?: string | null
          last_action_date?: string | null
          last_cpa_action?: string | null
          last_cpa_action_date?: string | null
          last_delivery_action?: string | null
          last_delivery_action_date?: string | null
          last_evaluated_at?: string
          last_roi?: number | null
          last_scale_date?: string | null
          lifecycle_status?: string
          roi_trend?: string | null
          site_id?: string | null
          updated_at?: string
          user_id?: string
          winner_country_code?: string | null
          winner_started_at?: string | null
        }
        Relationships: []
      }
      campaign_country_metrics: {
        Row: {
          campaign_id: string
          clicks: number
          conversions: number
          cost: number
          country_code: string
          country_criterion_id: string | null
          country_name: string | null
          created_at: string
          date: string
          google_account_id: string | null
          id: string
          impressions: number
          revenue_usd: number
          updated_at: string
          user_id: string
        }
        Insert: {
          campaign_id: string
          clicks?: number
          conversions?: number
          cost?: number
          country_code: string
          country_criterion_id?: string | null
          country_name?: string | null
          created_at?: string
          date: string
          google_account_id?: string | null
          id?: string
          impressions?: number
          revenue_usd?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          campaign_id?: string
          clicks?: number
          conversions?: number
          cost?: number
          country_code?: string
          country_criterion_id?: string | null
          country_name?: string | null
          created_at?: string
          date?: string
          google_account_id?: string | null
          id?: string
          impressions?: number
          revenue_usd?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      campaign_expansion_logs: {
        Row: {
          action: string
          budget_micros: number | null
          cost_brl: number | null
          country_code: string
          country_criterion_id: string | null
          country_name: string | null
          created_at: string
          error: string | null
          executed_at: string
          google_account_id: string | null
          id: string
          new_campaign_id: string | null
          new_campaign_name: string | null
          original_campaign_id: string
          original_campaign_name: string | null
          payload: Json | null
          revenue_brl: number | null
          roi_pct: number | null
          site_id: string | null
          status: string
          user_id: string
        }
        Insert: {
          action?: string
          budget_micros?: number | null
          cost_brl?: number | null
          country_code: string
          country_criterion_id?: string | null
          country_name?: string | null
          created_at?: string
          error?: string | null
          executed_at?: string
          google_account_id?: string | null
          id?: string
          new_campaign_id?: string | null
          new_campaign_name?: string | null
          original_campaign_id: string
          original_campaign_name?: string | null
          payload?: Json | null
          revenue_brl?: number | null
          roi_pct?: number | null
          site_id?: string | null
          status?: string
          user_id: string
        }
        Update: {
          action?: string
          budget_micros?: number | null
          cost_brl?: number | null
          country_code?: string
          country_criterion_id?: string | null
          country_name?: string | null
          created_at?: string
          error?: string | null
          executed_at?: string
          google_account_id?: string | null
          id?: string
          new_campaign_id?: string | null
          new_campaign_name?: string | null
          original_campaign_id?: string
          original_campaign_name?: string | null
          payload?: Json | null
          revenue_brl?: number | null
          roi_pct?: number | null
          site_id?: string | null
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      campaigns: {
        Row: {
          budget_micros: number | null
          campaign_id: string
          channel_type: string | null
          created_at: string
          google_account_id: string | null
          id: string
          name: string
          status: string
          target_cpa_micros: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          budget_micros?: number | null
          campaign_id: string
          channel_type?: string | null
          created_at?: string
          google_account_id?: string | null
          id?: string
          name: string
          status?: string
          target_cpa_micros?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          budget_micros?: number | null
          campaign_id?: string
          channel_type?: string | null
          created_at?: string
          google_account_id?: string | null
          id?: string
          name?: string
          status?: string
          target_cpa_micros?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_google_account_id_fkey"
            columns: ["google_account_id"]
            isOneToOne: false
            referencedRelation: "google_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_metrics: {
        Row: {
          campaign_id: string
          clicks: number
          conversions: number
          created_at: string
          date: string
          ecpm: number
          google_account_id: string | null
          id: string
          impressions: number
          profit: number
          revenue: number
          roas: number
          roi: number
          spend: number
          updated_at: string
          user_id: string
        }
        Insert: {
          campaign_id: string
          clicks?: number
          conversions?: number
          created_at?: string
          date: string
          ecpm?: number
          google_account_id?: string | null
          id?: string
          impressions?: number
          profit?: number
          revenue?: number
          roas?: number
          roi?: number
          spend?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          campaign_id?: string
          clicks?: number
          conversions?: number
          created_at?: string
          date?: string
          ecpm?: number
          google_account_id?: string | null
          id?: string
          impressions?: number
          profit?: number
          revenue?: number
          roas?: number
          roi?: number
          spend?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      exchange_rates: {
        Row: {
          from_currency: string
          id: string
          rate: number
          source: string | null
          to_currency: string
          updated_at: string
        }
        Insert: {
          from_currency: string
          id?: string
          rate: number
          source?: string | null
          to_currency: string
          updated_at?: string
        }
        Update: {
          from_currency?: string
          id?: string
          rate?: number
          source?: string | null
          to_currency?: string
          updated_at?: string
        }
        Relationships: []
      }
      gam_accounts: {
        Row: {
          account_name: string | null
          created_at: string
          id: string
          last_synced_at: string | null
          network_code: string
          service_account_email: string | null
          status: string
          user_id: string
        }
        Insert: {
          account_name?: string | null
          created_at?: string
          id?: string
          last_synced_at?: string | null
          network_code: string
          service_account_email?: string | null
          status?: string
          user_id: string
        }
        Update: {
          account_name?: string | null
          created_at?: string
          id?: string
          last_synced_at?: string | null
          network_code?: string
          service_account_email?: string | null
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      gam_campaign_source_revenue: {
        Row: {
          campaign_id: string
          created_at: string
          date: string
          id: string
          impressions: number
          revenue_usd: number
          site_id: string | null
          user_id: string
          utm_source: string
        }
        Insert: {
          campaign_id: string
          created_at?: string
          date: string
          id?: string
          impressions?: number
          revenue_usd?: number
          site_id?: string | null
          user_id: string
          utm_source: string
        }
        Update: {
          campaign_id?: string
          created_at?: string
          date?: string
          id?: string
          impressions?: number
          revenue_usd?: number
          site_id?: string | null
          user_id?: string
          utm_source?: string
        }
        Relationships: []
      }
      gam_placement_revenue: {
        Row: {
          campaign_id: string
          created_at: string
          date: string
          id: string
          impressions: number
          placement: string
          raw_utm: string | null
          revenue_usd: number
          site_id: string | null
          source: string | null
          user_id: string
          utm_source: string | null
        }
        Insert: {
          campaign_id: string
          created_at?: string
          date: string
          id?: string
          impressions?: number
          placement: string
          raw_utm?: string | null
          revenue_usd?: number
          site_id?: string | null
          source?: string | null
          user_id: string
          utm_source?: string | null
        }
        Update: {
          campaign_id?: string
          created_at?: string
          date?: string
          id?: string
          impressions?: number
          placement?: string
          raw_utm?: string | null
          revenue_usd?: number
          site_id?: string | null
          source?: string | null
          user_id?: string
          utm_source?: string | null
        }
        Relationships: []
      }
      geo_cleanup_logs: {
        Row: {
          action: string
          campaign_id: string
          campaign_name: string | null
          cost_brl: number | null
          country_code: string
          country_criterion_id: string | null
          country_name: string | null
          created_at: string
          executed_at: string
          google_account_id: string | null
          id: string
          lookback_days: number
          revenue_brl: number | null
          roi_pct: number | null
          site_id: string | null
          user_id: string
        }
        Insert: {
          action?: string
          campaign_id: string
          campaign_name?: string | null
          cost_brl?: number | null
          country_code: string
          country_criterion_id?: string | null
          country_name?: string | null
          created_at?: string
          executed_at?: string
          google_account_id?: string | null
          id?: string
          lookback_days?: number
          revenue_brl?: number | null
          roi_pct?: number | null
          site_id?: string | null
          user_id: string
        }
        Update: {
          action?: string
          campaign_id?: string
          campaign_name?: string | null
          cost_brl?: number | null
          country_code?: string
          country_criterion_id?: string | null
          country_name?: string | null
          created_at?: string
          executed_at?: string
          google_account_id?: string | null
          id?: string
          lookback_days?: number
          revenue_brl?: number | null
          roi_pct?: number | null
          site_id?: string | null
          user_id?: string
        }
        Relationships: []
      }
      google_accounts: {
        Row: {
          account_name: string | null
          created_at: string
          currency: string | null
          customer_id: string
          descriptive_name: string | null
          id: string
          is_mcc: boolean
          last_synced_at: string | null
          login_customer_id: string | null
          manager_account_id: string | null
          refresh_token: string | null
          status: string
          user_id: string
        }
        Insert: {
          account_name?: string | null
          created_at?: string
          currency?: string | null
          customer_id: string
          descriptive_name?: string | null
          id?: string
          is_mcc?: boolean
          last_synced_at?: string | null
          login_customer_id?: string | null
          manager_account_id?: string | null
          refresh_token?: string | null
          status?: string
          user_id: string
        }
        Update: {
          account_name?: string | null
          created_at?: string
          currency?: string | null
          customer_id?: string
          descriptive_name?: string | null
          id?: string
          is_mcc?: boolean
          last_synced_at?: string | null
          login_customer_id?: string | null
          manager_account_id?: string | null
          refresh_token?: string | null
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      placement_actions: {
        Row: {
          action: string
          campaign_id: string | null
          created_at: string
          id: string
          note: string | null
          placement: string
          user_id: string
        }
        Insert: {
          action: string
          campaign_id?: string | null
          created_at?: string
          id?: string
          note?: string | null
          placement: string
          user_id: string
        }
        Update: {
          action?: string
          campaign_id?: string | null
          created_at?: string
          id?: string
          note?: string | null
          placement?: string
          user_id?: string
        }
        Relationships: []
      }
      placement_cleanup_logs: {
        Row: {
          campaign_id: string
          campaign_name: string | null
          cost_before: number | null
          created_at: string
          executed_at: string
          google_account_id: string | null
          id: string
          lookback_days: number
          placements_removed_count: number
          removed_placements: Json | null
          revenue_before: number | null
          roi_before: number | null
          site_id: string | null
          user_id: string
        }
        Insert: {
          campaign_id: string
          campaign_name?: string | null
          cost_before?: number | null
          created_at?: string
          executed_at?: string
          google_account_id?: string | null
          id?: string
          lookback_days?: number
          placements_removed_count?: number
          removed_placements?: Json | null
          revenue_before?: number | null
          roi_before?: number | null
          site_id?: string | null
          user_id: string
        }
        Update: {
          campaign_id?: string
          campaign_name?: string | null
          cost_before?: number | null
          created_at?: string
          executed_at?: string
          google_account_id?: string | null
          id?: string
          lookback_days?: number
          placements_removed_count?: number
          removed_placements?: Json | null
          revenue_before?: number | null
          roi_before?: number | null
          site_id?: string | null
          user_id?: string
        }
        Relationships: []
      }
      placement_status: {
        Row: {
          app_id: string | null
          blocked_at: string | null
          campaign_id: string
          campaign_name: string | null
          clicks_total: number
          conversions_total: number
          cost_total: number
          created_at: string
          first_seen_at: string
          google_account_id: string | null
          id: string
          impressions_total: number
          last_evaluated_at: string
          last_status_change_at: string
          manual_override: boolean
          phase: string
          placement: string
          placement_type: string | null
          prev_roi_pct: number | null
          priority: boolean
          profit_total: number
          reason: string | null
          revenue_total: number
          roi_pct: number
          site_id: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          app_id?: string | null
          blocked_at?: string | null
          campaign_id: string
          campaign_name?: string | null
          clicks_total?: number
          conversions_total?: number
          cost_total?: number
          created_at?: string
          first_seen_at?: string
          google_account_id?: string | null
          id?: string
          impressions_total?: number
          last_evaluated_at?: string
          last_status_change_at?: string
          manual_override?: boolean
          phase?: string
          placement: string
          placement_type?: string | null
          prev_roi_pct?: number | null
          priority?: boolean
          profit_total?: number
          reason?: string | null
          revenue_total?: number
          roi_pct?: number
          site_id?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          app_id?: string | null
          blocked_at?: string | null
          campaign_id?: string
          campaign_name?: string | null
          clicks_total?: number
          conversions_total?: number
          cost_total?: number
          created_at?: string
          first_seen_at?: string
          google_account_id?: string | null
          id?: string
          impressions_total?: number
          last_evaluated_at?: string
          last_status_change_at?: string
          manual_override?: boolean
          phase?: string
          placement?: string
          placement_type?: string | null
          prev_roi_pct?: number | null
          priority?: boolean
          profit_total?: number
          reason?: string | null
          revenue_total?: number
          roi_pct?: number
          site_id?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      placement_status_history: {
        Row: {
          campaign_id: string
          cost_total: number | null
          created_at: string
          from_status: string | null
          id: string
          placement: string
          placement_status_id: string
          reason: string | null
          revenue_total: number | null
          roi_pct: number | null
          site_id: string | null
          to_status: string
          triggered_by: string
          user_id: string
        }
        Insert: {
          campaign_id: string
          cost_total?: number | null
          created_at?: string
          from_status?: string | null
          id?: string
          placement: string
          placement_status_id: string
          reason?: string | null
          revenue_total?: number | null
          roi_pct?: number | null
          site_id?: string | null
          to_status: string
          triggered_by?: string
          user_id: string
        }
        Update: {
          campaign_id?: string
          cost_total?: number | null
          created_at?: string
          from_status?: string | null
          id?: string
          placement?: string
          placement_status_id?: string
          reason?: string | null
          revenue_total?: number | null
          roi_pct?: number | null
          site_id?: string | null
          to_status?: string
          triggered_by?: string
          user_id?: string
        }
        Relationships: []
      }
      placements: {
        Row: {
          ad_unit: string | null
          campaign_id: string | null
          created_at: string
          date: string
          ecpm: number
          id: string
          impressions: number
          placement_key: string
          revenue: number
          site: string | null
          site_id: string | null
          user_id: string
        }
        Insert: {
          ad_unit?: string | null
          campaign_id?: string | null
          created_at?: string
          date: string
          ecpm?: number
          id?: string
          impressions?: number
          placement_key: string
          revenue?: number
          site?: string | null
          site_id?: string | null
          user_id: string
        }
        Update: {
          ad_unit?: string | null
          campaign_id?: string | null
          created_at?: string
          date?: string
          ecpm?: number
          id?: string
          impressions?: number
          placement_key?: string
          revenue?: number
          site?: string | null
          site_id?: string | null
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      rules_config: {
        Row: {
          analysis_days: number
          auto_analysis_days: number
          auto_boost_enabled: boolean
          auto_cpa_down_pct: number
          auto_cpa_review_days: number
          auto_cpa_up_pct: number
          auto_pause_enabled: boolean
          auto_scale_budget_pct: number
          auto_scale_interval_days: number
          auto_scale_min_roi: number
          auto_standby_enter_days: number
          auto_standby_exit_roi: number
          auto_standby_max_days: number
          auto_standby_roi_high: number
          auto_standby_roi_low: number
          auto_stoploss_days: number
          auto_stoploss_min_cost: number
          auto_stoploss_min_roi: number
          automation_dry_run: boolean
          automation_enabled: boolean
          automation_last_run_at: string | null
          boost_roi_pct: number
          budget_increase_pct: number
          funnel_auto_enabled: boolean
          funnel_auto_interval_days: number
          funnel_auto_last_run_at: string | null
          funnel_block_max_roi: number
          funnel_block_min_cost: number
          funnel_decision_bad_roi: number
          funnel_decision_good_roi: number
          funnel_learning_max_cost: number
          funnel_learning_min_roi: number
          funnel_protect_min_clicks: number
          funnel_protect_recent_conv_days: number
          funnel_scale_min_roi: number
          funnel_test_max_cost: number
          geo_auto_cleanup_enabled: boolean
          geo_cleanup_interval_days: number
          geo_cleanup_last_run_at: string | null
          geo_cleanup_lookback_days: number
          geo_cleanup_max_roi_pct: number
          geo_cleanup_min_campaign_cost_brl: number
          geo_cleanup_min_cost_brl: number
          geo_cleanup_min_countries: number
          geo_expansion_budget_multiplier: number
          geo_expansion_enabled: boolean
          geo_expansion_interval_days: number
          geo_expansion_last_run_at: string | null
          geo_expansion_lookback_days: number
          geo_expansion_min_campaign_cost_brl: number
          geo_expansion_min_countries: number
          geo_expansion_min_country_cost_brl: number
          geo_expansion_min_roi_pct: number
          max_loss_roi_pct: number
          min_roi_pct: number
          min_spend_threshold: number
          placement_auto_cleanup_enabled: boolean
          placement_cleanup_interval_days: number
          placement_cleanup_last_run_at: string | null
          placement_cleanup_max_roi_pct: number
          placement_cleanup_min_clicks: number
          placement_cleanup_min_cost_brl: number
          placement_cleanup_min_days: number
          updated_at: string
          user_id: string
        }
        Insert: {
          analysis_days?: number
          auto_analysis_days?: number
          auto_boost_enabled?: boolean
          auto_cpa_down_pct?: number
          auto_cpa_review_days?: number
          auto_cpa_up_pct?: number
          auto_pause_enabled?: boolean
          auto_scale_budget_pct?: number
          auto_scale_interval_days?: number
          auto_scale_min_roi?: number
          auto_standby_enter_days?: number
          auto_standby_exit_roi?: number
          auto_standby_max_days?: number
          auto_standby_roi_high?: number
          auto_standby_roi_low?: number
          auto_stoploss_days?: number
          auto_stoploss_min_cost?: number
          auto_stoploss_min_roi?: number
          automation_dry_run?: boolean
          automation_enabled?: boolean
          automation_last_run_at?: string | null
          boost_roi_pct?: number
          budget_increase_pct?: number
          funnel_auto_enabled?: boolean
          funnel_auto_interval_days?: number
          funnel_auto_last_run_at?: string | null
          funnel_block_max_roi?: number
          funnel_block_min_cost?: number
          funnel_decision_bad_roi?: number
          funnel_decision_good_roi?: number
          funnel_learning_max_cost?: number
          funnel_learning_min_roi?: number
          funnel_protect_min_clicks?: number
          funnel_protect_recent_conv_days?: number
          funnel_scale_min_roi?: number
          funnel_test_max_cost?: number
          geo_auto_cleanup_enabled?: boolean
          geo_cleanup_interval_days?: number
          geo_cleanup_last_run_at?: string | null
          geo_cleanup_lookback_days?: number
          geo_cleanup_max_roi_pct?: number
          geo_cleanup_min_campaign_cost_brl?: number
          geo_cleanup_min_cost_brl?: number
          geo_cleanup_min_countries?: number
          geo_expansion_budget_multiplier?: number
          geo_expansion_enabled?: boolean
          geo_expansion_interval_days?: number
          geo_expansion_last_run_at?: string | null
          geo_expansion_lookback_days?: number
          geo_expansion_min_campaign_cost_brl?: number
          geo_expansion_min_countries?: number
          geo_expansion_min_country_cost_brl?: number
          geo_expansion_min_roi_pct?: number
          max_loss_roi_pct?: number
          min_roi_pct?: number
          min_spend_threshold?: number
          placement_auto_cleanup_enabled?: boolean
          placement_cleanup_interval_days?: number
          placement_cleanup_last_run_at?: string | null
          placement_cleanup_max_roi_pct?: number
          placement_cleanup_min_clicks?: number
          placement_cleanup_min_cost_brl?: number
          placement_cleanup_min_days?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          analysis_days?: number
          auto_analysis_days?: number
          auto_boost_enabled?: boolean
          auto_cpa_down_pct?: number
          auto_cpa_review_days?: number
          auto_cpa_up_pct?: number
          auto_pause_enabled?: boolean
          auto_scale_budget_pct?: number
          auto_scale_interval_days?: number
          auto_scale_min_roi?: number
          auto_standby_enter_days?: number
          auto_standby_exit_roi?: number
          auto_standby_max_days?: number
          auto_standby_roi_high?: number
          auto_standby_roi_low?: number
          auto_stoploss_days?: number
          auto_stoploss_min_cost?: number
          auto_stoploss_min_roi?: number
          automation_dry_run?: boolean
          automation_enabled?: boolean
          automation_last_run_at?: string | null
          boost_roi_pct?: number
          budget_increase_pct?: number
          funnel_auto_enabled?: boolean
          funnel_auto_interval_days?: number
          funnel_auto_last_run_at?: string | null
          funnel_block_max_roi?: number
          funnel_block_min_cost?: number
          funnel_decision_bad_roi?: number
          funnel_decision_good_roi?: number
          funnel_learning_max_cost?: number
          funnel_learning_min_roi?: number
          funnel_protect_min_clicks?: number
          funnel_protect_recent_conv_days?: number
          funnel_scale_min_roi?: number
          funnel_test_max_cost?: number
          geo_auto_cleanup_enabled?: boolean
          geo_cleanup_interval_days?: number
          geo_cleanup_last_run_at?: string | null
          geo_cleanup_lookback_days?: number
          geo_cleanup_max_roi_pct?: number
          geo_cleanup_min_campaign_cost_brl?: number
          geo_cleanup_min_cost_brl?: number
          geo_cleanup_min_countries?: number
          geo_expansion_budget_multiplier?: number
          geo_expansion_enabled?: boolean
          geo_expansion_interval_days?: number
          geo_expansion_last_run_at?: string | null
          geo_expansion_lookback_days?: number
          geo_expansion_min_campaign_cost_brl?: number
          geo_expansion_min_countries?: number
          geo_expansion_min_country_cost_brl?: number
          geo_expansion_min_roi_pct?: number
          max_loss_roi_pct?: number
          min_roi_pct?: number
          min_spend_threshold?: number
          placement_auto_cleanup_enabled?: boolean
          placement_cleanup_interval_days?: number
          placement_cleanup_last_run_at?: string | null
          placement_cleanup_max_roi_pct?: number
          placement_cleanup_min_clicks?: number
          placement_cleanup_min_cost_brl?: number
          placement_cleanup_min_days?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      site_automation_config: {
        Row: {
          automation_dry_run: boolean
          automation_enabled: boolean
          created_at: string
          google_account_id: string
          id: string
          last_run_at: string | null
          site_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          automation_dry_run?: boolean
          automation_enabled?: boolean
          created_at?: string
          google_account_id: string
          id?: string
          last_run_at?: string | null
          site_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          automation_dry_run?: boolean
          automation_enabled?: boolean
          created_at?: string
          google_account_id?: string
          id?: string
          last_run_at?: string | null
          site_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      site_metrics_daily: {
        Row: {
          created_at: string
          currency: string
          date: string
          ecpm_native: number
          id: string
          impressions: number
          measurable_impressions: number
          revenue_native: number
          site_id: string
          updated_at: string
          user_id: string
          viewable_impressions: number
        }
        Insert: {
          created_at?: string
          currency?: string
          date: string
          ecpm_native?: number
          id?: string
          impressions?: number
          measurable_impressions?: number
          revenue_native?: number
          site_id: string
          updated_at?: string
          user_id: string
          viewable_impressions?: number
        }
        Update: {
          created_at?: string
          currency?: string
          date?: string
          ecpm_native?: number
          id?: string
          impressions?: number
          measurable_impressions?: number
          revenue_native?: number
          site_id?: string
          updated_at?: string
          user_id?: string
          viewable_impressions?: number
        }
        Relationships: []
      }
      site_placement_config: {
        Row: {
          automation_dry_run: boolean
          automation_enabled: boolean
          created_at: string
          google_account_id: string
          id: string
          interval_days: number
          last_run_at: string | null
          site_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          automation_dry_run?: boolean
          automation_enabled?: boolean
          created_at?: string
          google_account_id: string
          id?: string
          interval_days?: number
          last_run_at?: string | null
          site_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          automation_dry_run?: boolean
          automation_enabled?: boolean
          created_at?: string
          google_account_id?: string
          id?: string
          interval_days?: number
          last_run_at?: string | null
          site_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      sites: {
        Row: {
          created_at: string
          domain: string
          gam_account_id: string | null
          gam_currency: string
          gam_currency_detected_at: string | null
          gam_currency_override: boolean
          id: string
          name: string
          network_code: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          domain: string
          gam_account_id?: string | null
          gam_currency?: string
          gam_currency_detected_at?: string | null
          gam_currency_override?: boolean
          id?: string
          name: string
          network_code: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          domain?: string
          gam_account_id?: string | null
          gam_currency?: string
          gam_currency_detected_at?: string | null
          gam_currency_override?: boolean
          id?: string
          name?: string
          network_code?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      sync_logs: {
        Row: {
          error: string | null
          finished_at: string | null
          id: string
          records_processed: number | null
          source: string
          started_at: string
          status: string
          user_id: string
        }
        Insert: {
          error?: string | null
          finished_at?: string | null
          id?: string
          records_processed?: number | null
          source: string
          started_at?: string
          status: string
          user_id: string
        }
        Update: {
          error?: string | null
          finished_at?: string | null
          id?: string
          records_processed?: number | null
          source?: string
          started_at?: string
          status?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
