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
      admin_audit_logs: {
        Row: {
          action: string
          after: Json | null
          before: Json | null
          campaign_id: string | null
          created_at: string
          id: string
          ip: string | null
          resource_id: string | null
          resource_type: string | null
          site_id: string | null
          user_agent: string | null
          user_email: string | null
          user_id: string
        }
        Insert: {
          action: string
          after?: Json | null
          before?: Json | null
          campaign_id?: string | null
          created_at?: string
          id?: string
          ip?: string | null
          resource_id?: string | null
          resource_type?: string | null
          site_id?: string | null
          user_agent?: string | null
          user_email?: string | null
          user_id: string
        }
        Update: {
          action?: string
          after?: Json | null
          before?: Json | null
          campaign_id?: string | null
          created_at?: string
          id?: string
          ip?: string | null
          resource_id?: string | null
          resource_type?: string | null
          site_id?: string | null
          user_agent?: string | null
          user_email?: string | null
          user_id?: string
        }
        Relationships: []
      }
      admin_google_ads_permissions: {
        Row: {
          can_migrate: boolean
          can_sync: boolean
          can_view: boolean
          created_at: string
          google_account_id: string
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          can_migrate?: boolean
          can_sync?: boolean
          can_view?: boolean
          created_at?: string
          google_account_id: string
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          can_migrate?: boolean
          can_sync?: boolean
          can_view?: boolean
          created_at?: string
          google_account_id?: string
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      admin_module_permissions: {
        Row: {
          can_access: boolean
          can_edit: boolean
          created_at: string
          id: string
          module: string
          updated_at: string
          user_id: string
        }
        Insert: {
          can_access?: boolean
          can_edit?: boolean
          created_at?: string
          id?: string
          module: string
          updated_at?: string
          user_id: string
        }
        Update: {
          can_access?: boolean
          can_edit?: boolean
          created_at?: string
          id?: string
          module?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      admin_permissions: {
        Row: {
          can_edit_budgets: boolean
          can_edit_cpa: boolean
          can_edit_rules: boolean
          can_manage_push: boolean
          can_manage_users: boolean
          can_pause_campaigns: boolean
          can_run_automation: boolean
          can_scale_campaigns: boolean
          can_sync: boolean
          can_use_funil: boolean
          can_use_geo_expansion: boolean
          can_use_migration: boolean
          can_use_placements_cleanup: boolean
          can_view_dashboard: boolean
          can_view_logs: boolean
          can_view_profit: boolean
          can_view_revenue: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          can_edit_budgets?: boolean
          can_edit_cpa?: boolean
          can_edit_rules?: boolean
          can_manage_push?: boolean
          can_manage_users?: boolean
          can_pause_campaigns?: boolean
          can_run_automation?: boolean
          can_scale_campaigns?: boolean
          can_sync?: boolean
          can_use_funil?: boolean
          can_use_geo_expansion?: boolean
          can_use_migration?: boolean
          can_use_placements_cleanup?: boolean
          can_view_dashboard?: boolean
          can_view_logs?: boolean
          can_view_profit?: boolean
          can_view_revenue?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          can_edit_budgets?: boolean
          can_edit_cpa?: boolean
          can_edit_rules?: boolean
          can_manage_push?: boolean
          can_manage_users?: boolean
          can_pause_campaigns?: boolean
          can_run_automation?: boolean
          can_scale_campaigns?: boolean
          can_sync?: boolean
          can_use_funil?: boolean
          can_use_geo_expansion?: boolean
          can_use_migration?: boolean
          can_use_placements_cleanup?: boolean
          can_view_dashboard?: boolean
          can_view_logs?: boolean
          can_view_profit?: boolean
          can_view_revenue?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      admin_profiles: {
        Row: {
          created_at: string
          created_by: string | null
          is_active: boolean
          last_login_at: string | null
          name: string | null
          role: Database["public"]["Enums"]["app_role"]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          is_active?: boolean
          last_login_at?: string | null
          name?: string | null
          role?: Database["public"]["Enums"]["app_role"]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          is_active?: boolean
          last_login_at?: string | null
          name?: string | null
          role?: Database["public"]["Enums"]["app_role"]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      admin_site_access: {
        Row: {
          created_at: string
          id: string
          site_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          site_id: string
          user_id: string
        }
        Update: {
          created_at?: string
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
      ai_messages: {
        Row: {
          content: string | null
          created_at: string
          id: string
          parts: Json | null
          role: string
          thread_id: string
          user_id: string
        }
        Insert: {
          content?: string | null
          created_at?: string
          id?: string
          parts?: Json | null
          role: string
          thread_id: string
          user_id: string
        }
        Update: {
          content?: string | null
          created_at?: string
          id?: string
          parts?: Json | null
          role?: string
          thread_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_messages_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "ai_threads"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_provider_configs: {
        Row: {
          api_key_encrypted: string | null
          api_key_iv: string | null
          base_url: string | null
          created_at: string
          enabled: boolean
          id: string
          is_active: boolean
          last_test_error: string | null
          last_test_latency_ms: number | null
          last_test_status: string | null
          last_tested_at: string | null
          model: string | null
          provider: string
          updated_at: string
          user_id: string
        }
        Insert: {
          api_key_encrypted?: string | null
          api_key_iv?: string | null
          base_url?: string | null
          created_at?: string
          enabled?: boolean
          id?: string
          is_active?: boolean
          last_test_error?: string | null
          last_test_latency_ms?: number | null
          last_test_status?: string | null
          last_tested_at?: string | null
          model?: string | null
          provider: string
          updated_at?: string
          user_id: string
        }
        Update: {
          api_key_encrypted?: string | null
          api_key_iv?: string | null
          base_url?: string | null
          created_at?: string
          enabled?: boolean
          id?: string
          is_active?: boolean
          last_test_error?: string | null
          last_test_latency_ms?: number | null
          last_test_status?: string | null
          last_tested_at?: string | null
          model?: string | null
          provider?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      ai_threads: {
        Row: {
          active_tab: string | null
          context: Json
          created_at: string
          id: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          active_tab?: string | null
          context?: Json
          created_at?: string
          id?: string
          title?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          active_tab?: string | null
          context?: Json
          created_at?: string
          id?: string
          title?: string
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
          auto_pause_resume_count: number
          auto_pause_resumed_at: string | null
          auto_pause_review_at: string | null
          auto_pause_snapshot: Json | null
          auto_pause_state: string | null
          auto_paused_at: string | null
          auto_paused_reason: string | null
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
          roi_today: number | null
          roi_trend: string | null
          scale_unlock_locked_until: string | null
          scaling_since: string | null
          second_chance_reason: string | null
          second_chance_started_at: string | null
          site_id: string | null
          sub_threshold_days: number
          updated_at: string
          user_id: string
          winner_country_code: string | null
          winner_started_at: string | null
        }
        Insert: {
          auto_pause_resume_count?: number
          auto_pause_resumed_at?: string | null
          auto_pause_review_at?: string | null
          auto_pause_snapshot?: Json | null
          auto_pause_state?: string | null
          auto_paused_at?: string | null
          auto_paused_reason?: string | null
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
          roi_today?: number | null
          roi_trend?: string | null
          scale_unlock_locked_until?: string | null
          scaling_since?: string | null
          second_chance_reason?: string | null
          second_chance_started_at?: string | null
          site_id?: string | null
          sub_threshold_days?: number
          updated_at?: string
          user_id: string
          winner_country_code?: string | null
          winner_started_at?: string | null
        }
        Update: {
          auto_pause_resume_count?: number
          auto_pause_resumed_at?: string | null
          auto_pause_review_at?: string | null
          auto_pause_snapshot?: Json | null
          auto_pause_state?: string | null
          auto_paused_at?: string | null
          auto_paused_reason?: string | null
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
          roi_today?: number | null
          roi_trend?: string | null
          scale_unlock_locked_until?: string | null
          scaling_since?: string | null
          second_chance_reason?: string | null
          second_chance_started_at?: string | null
          site_id?: string | null
          sub_threshold_days?: number
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
      campaign_final_urls: {
        Row: {
          ad_group_id: string | null
          ad_id: string
          ad_status: string | null
          campaign_id: string
          created_at: string
          final_url: string | null
          final_url_suffix: string | null
          google_account_id: string | null
          id: string
          mobile_url: string | null
          source: string
          tracking_template: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          ad_group_id?: string | null
          ad_id?: string
          ad_status?: string | null
          campaign_id: string
          created_at?: string
          final_url?: string | null
          final_url_suffix?: string | null
          google_account_id?: string | null
          id?: string
          mobile_url?: string | null
          source?: string
          tracking_template?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          ad_group_id?: string | null
          ad_id?: string
          ad_status?: string | null
          campaign_id?: string
          created_at?: string
          final_url?: string | null
          final_url_suffix?: string | null
          google_account_id?: string | null
          id?: string
          mobile_url?: string | null
          source?: string
          tracking_template?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      campaign_funnel: {
        Row: {
          advanced_scaling_started_at: string | null
          applied_target_cpa: number | null
          avg_cpa_5d: number | null
          bad_roi_days: number
          campaign_id: string
          campaign_name: string | null
          consecutive_high_roi_days: number
          cooldown_cpa_until: string | null
          cooldown_scale_until: string | null
          cpa_learning_started_at: string | null
          created_at: string
          current_budget: number | null
          entered_at: string
          entry_source: string
          funnel_status: string
          google_account_id: string | null
          graduated_at: string | null
          id: string
          initial_budget: number
          last_action: string | null
          last_action_reason: string | null
          last_cpa_change_at: string | null
          last_delivery_rate: number | null
          last_evaluated_at: string | null
          last_roi_pct: number | null
          last_scale_at: string | null
          learning_started_at: string
          next_action_hint: string | null
          paused_at: string | null
          scale_unlock_locked_until: string | null
          scaling_started_at: string | null
          site_id: string | null
          stable_started_at: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          advanced_scaling_started_at?: string | null
          applied_target_cpa?: number | null
          avg_cpa_5d?: number | null
          bad_roi_days?: number
          campaign_id: string
          campaign_name?: string | null
          consecutive_high_roi_days?: number
          cooldown_cpa_until?: string | null
          cooldown_scale_until?: string | null
          cpa_learning_started_at?: string | null
          created_at?: string
          current_budget?: number | null
          entered_at?: string
          entry_source?: string
          funnel_status?: string
          google_account_id?: string | null
          graduated_at?: string | null
          id?: string
          initial_budget?: number
          last_action?: string | null
          last_action_reason?: string | null
          last_cpa_change_at?: string | null
          last_delivery_rate?: number | null
          last_evaluated_at?: string | null
          last_roi_pct?: number | null
          last_scale_at?: string | null
          learning_started_at?: string
          next_action_hint?: string | null
          paused_at?: string | null
          scale_unlock_locked_until?: string | null
          scaling_started_at?: string | null
          site_id?: string | null
          stable_started_at?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          advanced_scaling_started_at?: string | null
          applied_target_cpa?: number | null
          avg_cpa_5d?: number | null
          bad_roi_days?: number
          campaign_id?: string
          campaign_name?: string | null
          consecutive_high_roi_days?: number
          cooldown_cpa_until?: string | null
          cooldown_scale_until?: string | null
          cpa_learning_started_at?: string | null
          created_at?: string
          current_budget?: number | null
          entered_at?: string
          entry_source?: string
          funnel_status?: string
          google_account_id?: string | null
          graduated_at?: string | null
          id?: string
          initial_budget?: number
          last_action?: string | null
          last_action_reason?: string | null
          last_cpa_change_at?: string | null
          last_delivery_rate?: number | null
          last_evaluated_at?: string | null
          last_roi_pct?: number | null
          last_scale_at?: string | null
          learning_started_at?: string
          next_action_hint?: string | null
          paused_at?: string | null
          scale_unlock_locked_until?: string | null
          scaling_started_at?: string | null
          site_id?: string | null
          stable_started_at?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      campaign_funnel_logs: {
        Row: {
          action: string
          avg_cpa: number | null
          budget_after: number | null
          budget_before: number | null
          campaign_id: string
          campaign_name: string | null
          cpa_after: number | null
          cpa_before: number | null
          created_at: string
          delivery_rate: number | null
          dry_run: boolean
          error: string | null
          funnel_id: string | null
          google_account_id: string | null
          id: string
          payload: Json | null
          reason: string | null
          roi_pct: number | null
          site_id: string | null
          status_from: string | null
          status_to: string | null
          user_id: string
        }
        Insert: {
          action: string
          avg_cpa?: number | null
          budget_after?: number | null
          budget_before?: number | null
          campaign_id: string
          campaign_name?: string | null
          cpa_after?: number | null
          cpa_before?: number | null
          created_at?: string
          delivery_rate?: number | null
          dry_run?: boolean
          error?: string | null
          funnel_id?: string | null
          google_account_id?: string | null
          id?: string
          payload?: Json | null
          reason?: string | null
          roi_pct?: number | null
          site_id?: string | null
          status_from?: string | null
          status_to?: string | null
          user_id: string
        }
        Update: {
          action?: string
          avg_cpa?: number | null
          budget_after?: number | null
          budget_before?: number | null
          campaign_id?: string
          campaign_name?: string | null
          cpa_after?: number | null
          cpa_before?: number | null
          created_at?: string
          delivery_rate?: number | null
          dry_run?: boolean
          error?: string | null
          funnel_id?: string | null
          google_account_id?: string | null
          id?: string
          payload?: Json | null
          reason?: string | null
          roi_pct?: number | null
          site_id?: string | null
          status_from?: string | null
          status_to?: string | null
          user_id?: string
        }
        Relationships: []
      }
      campaign_migrations: {
        Row: {
          created_at: string
          destination_campaign_id: string | null
          destination_domain: string | null
          destination_google_account_id: string | null
          destination_site_id: string | null
          error: string | null
          executed_at: string | null
          final_url: string
          final_url_suffix: string | null
          id: string
          initial_budget: number | null
          name_suffix: string | null
          payload: Json | null
          result: Json | null
          source_campaign_id: string
          source_campaign_name: string | null
          source_domain: string | null
          source_google_account_id: string | null
          source_site_id: string | null
          status: string
          tracking_template: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          destination_campaign_id?: string | null
          destination_domain?: string | null
          destination_google_account_id?: string | null
          destination_site_id?: string | null
          error?: string | null
          executed_at?: string | null
          final_url: string
          final_url_suffix?: string | null
          id?: string
          initial_budget?: number | null
          name_suffix?: string | null
          payload?: Json | null
          result?: Json | null
          source_campaign_id: string
          source_campaign_name?: string | null
          source_domain?: string | null
          source_google_account_id?: string | null
          source_site_id?: string | null
          status?: string
          tracking_template?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          destination_campaign_id?: string | null
          destination_domain?: string | null
          destination_google_account_id?: string | null
          destination_site_id?: string | null
          error?: string | null
          executed_at?: string | null
          final_url?: string
          final_url_suffix?: string | null
          id?: string
          initial_budget?: number | null
          name_suffix?: string | null
          payload?: Json | null
          result?: Json | null
          source_campaign_id?: string
          source_campaign_name?: string | null
          source_domain?: string | null
          source_google_account_id?: string | null
          source_site_id?: string | null
          status?: string
          tracking_template?: string | null
          user_id?: string
        }
        Relationships: []
      }
      campaign_restart_flow: {
        Row: {
          applied_cpa: number | null
          avg_cpa: number | null
          campaign_id: string
          created_at: string
          current_budget: number | null
          delivery_ratio: number | null
          finished_at: string | null
          google_account_id: string | null
          id: string
          initial_budget: number | null
          last_action: string | null
          last_action_at: string | null
          notes: string | null
          phase2_started_at: string | null
          phase3_started_at: string | null
          phase4_started_at: string | null
          roi: number | null
          site_id: string | null
          stage: string
          start_date: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          applied_cpa?: number | null
          avg_cpa?: number | null
          campaign_id: string
          created_at?: string
          current_budget?: number | null
          delivery_ratio?: number | null
          finished_at?: string | null
          google_account_id?: string | null
          id?: string
          initial_budget?: number | null
          last_action?: string | null
          last_action_at?: string | null
          notes?: string | null
          phase2_started_at?: string | null
          phase3_started_at?: string | null
          phase4_started_at?: string | null
          roi?: number | null
          site_id?: string | null
          stage?: string
          start_date?: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          applied_cpa?: number | null
          avg_cpa?: number | null
          campaign_id?: string
          created_at?: string
          current_budget?: number | null
          delivery_ratio?: number | null
          finished_at?: string | null
          google_account_id?: string | null
          id?: string
          initial_budget?: number | null
          last_action?: string | null
          last_action_at?: string | null
          notes?: string | null
          phase2_started_at?: string | null
          phase3_started_at?: string | null
          phase4_started_at?: string | null
          roi?: number | null
          site_id?: string | null
          stage?: string
          start_date?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      campaigns: {
        Row: {
          bidding_strategy_type: string | null
          budget_micros: number | null
          campaign_id: string
          channel_type: string | null
          created_at: string
          final_url_suffix: string | null
          google_account_id: string | null
          id: string
          name: string
          operational_note: string | null
          operational_status: string | null
          operational_status_at: string | null
          operational_status_expires_at: string | null
          start_date: string | null
          status: string
          target_cpa_micros: number | null
          updated_at: string
          user_id: string
          utm_applied_at: string | null
        }
        Insert: {
          bidding_strategy_type?: string | null
          budget_micros?: number | null
          campaign_id: string
          channel_type?: string | null
          created_at?: string
          final_url_suffix?: string | null
          google_account_id?: string | null
          id?: string
          name: string
          operational_note?: string | null
          operational_status?: string | null
          operational_status_at?: string | null
          operational_status_expires_at?: string | null
          start_date?: string | null
          status?: string
          target_cpa_micros?: number | null
          updated_at?: string
          user_id: string
          utm_applied_at?: string | null
        }
        Update: {
          bidding_strategy_type?: string | null
          budget_micros?: number | null
          campaign_id?: string
          channel_type?: string | null
          created_at?: string
          final_url_suffix?: string | null
          google_account_id?: string | null
          id?: string
          name?: string
          operational_note?: string | null
          operational_status?: string | null
          operational_status_at?: string | null
          operational_status_expires_at?: string | null
          start_date?: string | null
          status?: string
          target_cpa_micros?: number | null
          updated_at?: string
          user_id?: string
          utm_applied_at?: string | null
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
      canonical_attribution_audit_reports: {
        Row: {
          aggregate_allocated_revenue_usd: number
          aggregate_distribution: Json
          aggregate_revenue_usd: number
          aggregate_unresolved_revenue_usd: number
          campaign_match_pct: number
          created_at: string
          exact_utm_placement_pct: number
          id: string
          leak_amount_usd: number
          leak_percent: number
          period_end: string
          period_start: string
          raw_samples: Json
          reconciled_revenue_usd: number
          report: Json
          revenue_sources: Json
          site_id: string | null
          top_unreconciled_rows: Json
          total_gam_revenue_usd: number
          user_id: string
        }
        Insert: {
          aggregate_allocated_revenue_usd?: number
          aggregate_distribution?: Json
          aggregate_revenue_usd?: number
          aggregate_unresolved_revenue_usd?: number
          campaign_match_pct?: number
          created_at?: string
          exact_utm_placement_pct?: number
          id?: string
          leak_amount_usd?: number
          leak_percent?: number
          period_end: string
          period_start: string
          raw_samples?: Json
          reconciled_revenue_usd?: number
          report?: Json
          revenue_sources?: Json
          site_id?: string | null
          top_unreconciled_rows?: Json
          total_gam_revenue_usd?: number
          user_id: string
        }
        Update: {
          aggregate_allocated_revenue_usd?: number
          aggregate_distribution?: Json
          aggregate_revenue_usd?: number
          aggregate_unresolved_revenue_usd?: number
          campaign_match_pct?: number
          created_at?: string
          exact_utm_placement_pct?: number
          id?: string
          leak_amount_usd?: number
          leak_percent?: number
          period_end?: string
          period_start?: string
          raw_samples?: Json
          reconciled_revenue_usd?: number
          report?: Json
          revenue_sources?: Json
          site_id?: string | null
          top_unreconciled_rows?: Json
          total_gam_revenue_usd?: number
          user_id?: string
        }
        Relationships: []
      }
      creative_metrics: {
        Row: {
          ad_group_id: string
          ad_group_name: string | null
          ad_id: string
          ad_name: string | null
          ad_status: string | null
          ad_type: string | null
          campaign_id: string
          campaign_name: string | null
          clicks: number
          conversions: number
          cost: number
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
          ad_group_id: string
          ad_group_name?: string | null
          ad_id: string
          ad_name?: string | null
          ad_status?: string | null
          ad_type?: string | null
          campaign_id: string
          campaign_name?: string | null
          clicks?: number
          conversions?: number
          cost?: number
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
          ad_group_id?: string
          ad_group_name?: string | null
          ad_id?: string
          ad_name?: string | null
          ad_status?: string | null
          ad_type?: string | null
          campaign_id?: string
          campaign_name?: string | null
          clicks?: number
          conversions?: number
          cost?: number
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
      daily_financial_snapshots: {
        Row: {
          adsense_revenue: number | null
          adx_revenue: number | null
          clicks: number
          conversions: number
          created_at: string
          currency: string
          date: string
          ecpm: number
          facebook_ads_cost: number
          fixed_cost: number
          google_ads_cost: number
          gross_revenue: number
          id: string
          impressions: number
          liquid_profit: number
          net_revenue: number
          other_cost: number
          profit_margin_pct: number
          revenue_after_revshare: number
          revenue_currency: string
          site_id: string
          taxes: number
          total_cost: number
          user_id: string
          viewability: number
        }
        Insert: {
          adsense_revenue?: number | null
          adx_revenue?: number | null
          clicks?: number
          conversions?: number
          created_at?: string
          currency?: string
          date: string
          ecpm?: number
          facebook_ads_cost?: number
          fixed_cost?: number
          google_ads_cost?: number
          gross_revenue?: number
          id?: string
          impressions?: number
          liquid_profit?: number
          net_revenue?: number
          other_cost?: number
          profit_margin_pct?: number
          revenue_after_revshare?: number
          revenue_currency?: string
          site_id: string
          taxes?: number
          total_cost?: number
          user_id: string
          viewability?: number
        }
        Update: {
          adsense_revenue?: number | null
          adx_revenue?: number | null
          clicks?: number
          conversions?: number
          created_at?: string
          currency?: string
          date?: string
          ecpm?: number
          facebook_ads_cost?: number
          fixed_cost?: number
          google_ads_cost?: number
          gross_revenue?: number
          id?: string
          impressions?: number
          liquid_profit?: number
          net_revenue?: number
          other_cost?: number
          profit_margin_pct?: number
          revenue_after_revshare?: number
          revenue_currency?: string
          site_id?: string
          taxes?: number
          total_cost?: number
          user_id?: string
          viewability?: number
        }
        Relationships: [
          {
            foreignKeyName: "daily_financial_snapshots_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "sites"
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
          attribution_status: string | null
          campaign_id: string
          created_at: string
          date: string
          id: string
          impressions: number
          match_rate_pct: number | null
          revenue_usd: number
          site_id: string | null
          total_requests: number
          user_id: string
          utm_source: string
        }
        Insert: {
          attribution_status?: string | null
          campaign_id: string
          created_at?: string
          date: string
          id?: string
          impressions?: number
          match_rate_pct?: number | null
          revenue_usd?: number
          site_id?: string | null
          total_requests?: number
          user_id: string
          utm_source: string
        }
        Update: {
          attribution_status?: string | null
          campaign_id?: string
          created_at?: string
          date?: string
          id?: string
          impressions?: number
          match_rate_pct?: number | null
          revenue_usd?: number
          site_id?: string | null
          total_requests?: number
          user_id?: string
          utm_source?: string
        }
        Relationships: []
      }
      gam_placement_revenue: {
        Row: {
          attribution_status: string | null
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
          attribution_status?: string | null
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
          attribution_status?: string | null
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
      gam_url_ad_unit_daily: {
        Row: {
          ad_requests: number
          ad_unit_name: string
          campaign_id: string | null
          created_at: string
          date: string
          google_account_id: string | null
          id: string
          match_rate_pct: number | null
          matched_impressions: number
          revenue_usd: number
          site_id: string | null
          updated_at: string
          url_normalized: string | null
          url_raw: string | null
          user_id: string
        }
        Insert: {
          ad_requests?: number
          ad_unit_name: string
          campaign_id?: string | null
          created_at?: string
          date: string
          google_account_id?: string | null
          id?: string
          match_rate_pct?: number | null
          matched_impressions?: number
          revenue_usd?: number
          site_id?: string | null
          updated_at?: string
          url_normalized?: string | null
          url_raw?: string | null
          user_id: string
        }
        Update: {
          ad_requests?: number
          ad_unit_name?: string
          campaign_id?: string | null
          created_at?: string
          date?: string
          google_account_id?: string | null
          id?: string
          match_rate_pct?: number | null
          matched_impressions?: number
          revenue_usd?: number
          site_id?: string | null
          updated_at?: string
          url_normalized?: string | null
          url_raw?: string | null
          user_id?: string
        }
        Relationships: []
      }
      gam_url_revenue: {
        Row: {
          created_at: string
          date: string
          id: string
          impressions: number
          revenue_usd: number
          site_id: string | null
          url: string
          user_id: string
          utm_source: string | null
        }
        Insert: {
          created_at?: string
          date: string
          id?: string
          impressions?: number
          revenue_usd?: number
          site_id?: string | null
          url: string
          user_id: string
          utm_source?: string | null
        }
        Update: {
          created_at?: string
          date?: string
          id?: string
          impressions?: number
          revenue_usd?: number
          site_id?: string | null
          url?: string
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
          api_set: number
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
          sync_enabled: boolean | null
          user_id: string
        }
        Insert: {
          account_name?: string | null
          api_set?: number
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
          sync_enabled?: boolean | null
          user_id: string
        }
        Update: {
          account_name?: string | null
          api_set?: number
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
          sync_enabled?: boolean | null
          user_id?: string
        }
        Relationships: []
      }
      html5_bundle_library: {
        Row: {
          content_type: string | null
          created_at: string
          file_size: number | null
          id: string
          notes: string | null
          source_ad_id: string | null
          source_ad_name: string | null
          source_campaign_id: string | null
          source_campaign_name: string | null
          source_google_account_id: string | null
          updated_at: string
          user_id: string
          zip_filename: string | null
          zip_storage_path: string
        }
        Insert: {
          content_type?: string | null
          created_at?: string
          file_size?: number | null
          id?: string
          notes?: string | null
          source_ad_id?: string | null
          source_ad_name?: string | null
          source_campaign_id?: string | null
          source_campaign_name?: string | null
          source_google_account_id?: string | null
          updated_at?: string
          user_id: string
          zip_filename?: string | null
          zip_storage_path: string
        }
        Update: {
          content_type?: string | null
          created_at?: string
          file_size?: number | null
          id?: string
          notes?: string | null
          source_ad_id?: string | null
          source_ad_name?: string | null
          source_campaign_id?: string | null
          source_campaign_name?: string | null
          source_google_account_id?: string | null
          updated_at?: string
          user_id?: string
          zip_filename?: string | null
          zip_storage_path?: string
        }
        Relationships: []
      }
      migration_pending_ads: {
        Row: {
          created_at: string
          destination_ad_group_name: string | null
          destination_ad_group_resource: string
          destination_campaign_id: string
          destination_customer_id: string
          destination_google_account_id: string | null
          display_upload_product_type: string | null
          final_url: string
          final_url_suffix: string | null
          id: string
          migration_id: string
          reason: string | null
          resolved_at: string | null
          source_ad_id: string | null
          source_ad_name: string | null
          source_ad_type: string
          source_bundle_asset: string | null
          status: string
          updated_at: string
          uploaded_ad_resource: string | null
          user_id: string
          zip_storage_path: string | null
        }
        Insert: {
          created_at?: string
          destination_ad_group_name?: string | null
          destination_ad_group_resource: string
          destination_campaign_id: string
          destination_customer_id: string
          destination_google_account_id?: string | null
          display_upload_product_type?: string | null
          final_url: string
          final_url_suffix?: string | null
          id?: string
          migration_id: string
          reason?: string | null
          resolved_at?: string | null
          source_ad_id?: string | null
          source_ad_name?: string | null
          source_ad_type: string
          source_bundle_asset?: string | null
          status?: string
          updated_at?: string
          uploaded_ad_resource?: string | null
          user_id: string
          zip_storage_path?: string | null
        }
        Update: {
          created_at?: string
          destination_ad_group_name?: string | null
          destination_ad_group_resource?: string
          destination_campaign_id?: string
          destination_customer_id?: string
          destination_google_account_id?: string | null
          display_upload_product_type?: string | null
          final_url?: string
          final_url_suffix?: string | null
          id?: string
          migration_id?: string
          reason?: string | null
          resolved_at?: string | null
          source_ad_id?: string | null
          source_ad_name?: string | null
          source_ad_type?: string
          source_bundle_asset?: string | null
          status?: string
          updated_at?: string
          uploaded_ad_resource?: string | null
          user_id?: string
          zip_storage_path?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "migration_pending_ads_migration_id_fkey"
            columns: ["migration_id"]
            isOneToOne: false
            referencedRelation: "campaign_migrations"
            referencedColumns: ["id"]
          },
        ]
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
      placement_revenue_audit: {
        Row: {
          audit_status: string
          campaign_id: string
          campaign_name: string | null
          campaign_revenue_usd: number
          confidence: number
          created_at: string
          findings: Json
          google_account_id: string | null
          id: string
          leak_amount_usd: number
          leak_percent: number
          match_success_pct: number | null
          orphan_rows: number
          parser_success_pct: number | null
          period_end: string
          period_match_pct: number | null
          period_start: string
          placements_revenue_usd: number
          rebuild_summary: Json | null
          rebuilt: boolean
          site_id: string | null
          site_match_pct: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          audit_status?: string
          campaign_id: string
          campaign_name?: string | null
          campaign_revenue_usd?: number
          confidence?: number
          created_at?: string
          findings?: Json
          google_account_id?: string | null
          id?: string
          leak_amount_usd?: number
          leak_percent?: number
          match_success_pct?: number | null
          orphan_rows?: number
          parser_success_pct?: number | null
          period_end: string
          period_match_pct?: number | null
          period_start: string
          placements_revenue_usd?: number
          rebuild_summary?: Json | null
          rebuilt?: boolean
          site_id?: string | null
          site_match_pct?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          audit_status?: string
          campaign_id?: string
          campaign_name?: string | null
          campaign_revenue_usd?: number
          confidence?: number
          created_at?: string
          findings?: Json
          google_account_id?: string | null
          id?: string
          leak_amount_usd?: number
          leak_percent?: number
          match_success_pct?: number | null
          orphan_rows?: number
          parser_success_pct?: number | null
          period_end?: string
          period_match_pct?: number | null
          period_start?: string
          placements_revenue_usd?: number
          rebuild_summary?: Json | null
          rebuilt?: boolean
          site_id?: string | null
          site_match_pct?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      placement_revenue_reconciled: {
        Row: {
          aggregate_allocated_revenue_usd: number
          allocation_method: string | null
          allocation_status: string
          broken_tracking: boolean
          campaign_id: string
          canonical_key: string
          clicks: number
          confidence: number
          created_at: string
          date: string
          ecpm: number | null
          google_account_id: string | null
          id: string
          impressions: number
          normalized_placement: string
          placement: string
          reconciliation_method: string
          revenue_usd: number
          site_id: string | null
          source_row: Json | null
          updated_at: string
          user_id: string
        }
        Insert: {
          aggregate_allocated_revenue_usd?: number
          allocation_method?: string | null
          allocation_status?: string
          broken_tracking?: boolean
          campaign_id: string
          canonical_key: string
          clicks?: number
          confidence?: number
          created_at?: string
          date: string
          ecpm?: number | null
          google_account_id?: string | null
          id?: string
          impressions?: number
          normalized_placement: string
          placement: string
          reconciliation_method?: string
          revenue_usd?: number
          site_id?: string | null
          source_row?: Json | null
          updated_at?: string
          user_id: string
        }
        Update: {
          aggregate_allocated_revenue_usd?: number
          allocation_method?: string | null
          allocation_status?: string
          broken_tracking?: boolean
          campaign_id?: string
          canonical_key?: string
          clicks?: number
          confidence?: number
          created_at?: string
          date?: string
          ecpm?: number | null
          google_account_id?: string | null
          id?: string
          impressions?: number
          normalized_placement?: string
          placement?: string
          reconciliation_method?: string
          revenue_usd?: number
          site_id?: string | null
          source_row?: Json | null
          updated_at?: string
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
          site_scope: string
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
          site_scope?: string
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
          site_scope?: string
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
      push_retention_revenue: {
        Row: {
          created_at: string
          date: string
          ecpm: number
          id: string
          impressions: number
          normalized_url: string
          raw_gam_row: Json | null
          revenue_usd: number
          site_id: string
          source: string | null
          updated_at: string
          url: string
          user_id: string
          utm_source: string
        }
        Insert: {
          created_at?: string
          date: string
          ecpm?: number
          id?: string
          impressions?: number
          normalized_url: string
          raw_gam_row?: Json | null
          revenue_usd?: number
          site_id: string
          source?: string | null
          updated_at?: string
          url: string
          user_id: string
          utm_source: string
        }
        Update: {
          created_at?: string
          date?: string
          ecpm?: number
          id?: string
          impressions?: number
          normalized_url?: string
          raw_gam_row?: Json | null
          revenue_usd?: number
          site_id?: string
          source?: string | null
          updated_at?: string
          url?: string
          user_id?: string
          utm_source?: string
        }
        Relationships: []
      }
      push_url_revenue: {
        Row: {
          created_at: string
          date: string
          ecpm: number
          id: string
          impressions: number
          network_code: string | null
          page_url: string
          revenue_usd: number
          site_id: string | null
          user_id: string
          utm_campaign: string
          utm_source: string
        }
        Insert: {
          created_at?: string
          date: string
          ecpm?: number
          id?: string
          impressions?: number
          network_code?: string | null
          page_url: string
          revenue_usd?: number
          site_id?: string | null
          user_id: string
          utm_campaign?: string
          utm_source?: string
        }
        Update: {
          created_at?: string
          date?: string
          ecpm?: number
          id?: string
          impressions?: number
          network_code?: string | null
          page_url?: string
          revenue_usd?: number
          site_id?: string | null
          user_id?: string
          utm_campaign?: string
          utm_source?: string
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
          creative_auto_optimize_enabled: boolean
          creative_min_cost_brl: number
          creative_min_days: number
          creative_min_roi_diff_pct: number
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
          funnel_smart_enabled: boolean
          funnel_smart_last_run_at: string | null
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
          revenue_share_pct: number
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
          creative_auto_optimize_enabled?: boolean
          creative_min_cost_brl?: number
          creative_min_days?: number
          creative_min_roi_diff_pct?: number
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
          funnel_smart_enabled?: boolean
          funnel_smart_last_run_at?: string | null
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
          revenue_share_pct?: number
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
          creative_auto_optimize_enabled?: boolean
          creative_min_cost_brl?: number
          creative_min_days?: number
          creative_min_roi_diff_pct?: number
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
          funnel_smart_enabled?: boolean
          funnel_smart_last_run_at?: string | null
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
          revenue_share_pct?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      scale_unlock_config: {
        Row: {
          cooldown_hours: number
          created_at: string
          dry_run: boolean
          enabled: boolean
          fail_after_days: number
          fail_max_roi: number
          id: string
          last_run_at: string | null
          lookback_days: number
          max_delivery_rate: number
          min_conversions: number
          min_ctr_pct: number
          min_roi_pct: number
          min_spend_brl: number
          observation_hours: number
          reduce_budget_pct: number
          relax_cpa_pct: number
          scale_interval_hours: number
          scale_min_delivery: number
          scale_min_roi_pct: number
          scale_pct: number
          updated_at: string
          user_id: string
        }
        Insert: {
          cooldown_hours?: number
          created_at?: string
          dry_run?: boolean
          enabled?: boolean
          fail_after_days?: number
          fail_max_roi?: number
          id?: string
          last_run_at?: string | null
          lookback_days?: number
          max_delivery_rate?: number
          min_conversions?: number
          min_ctr_pct?: number
          min_roi_pct?: number
          min_spend_brl?: number
          observation_hours?: number
          reduce_budget_pct?: number
          relax_cpa_pct?: number
          scale_interval_hours?: number
          scale_min_delivery?: number
          scale_min_roi_pct?: number
          scale_pct?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          cooldown_hours?: number
          created_at?: string
          dry_run?: boolean
          enabled?: boolean
          fail_after_days?: number
          fail_max_roi?: number
          id?: string
          last_run_at?: string | null
          lookback_days?: number
          max_delivery_rate?: number
          min_conversions?: number
          min_ctr_pct?: number
          min_roi_pct?: number
          min_spend_brl?: number
          observation_hours?: number
          reduce_budget_pct?: number
          relax_cpa_pct?: number
          scale_interval_hours?: number
          scale_min_delivery?: number
          scale_min_roi_pct?: number
          scale_pct?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      scale_unlock_logs: {
        Row: {
          action: string
          campaign_id: string
          campaign_name: string | null
          created_at: string
          delivery_after: number | null
          delivery_before: number | null
          error: string | null
          google_account_id: string | null
          id: string
          new_budget: number | null
          new_cpa: number | null
          old_budget: number | null
          old_cpa: number | null
          payload: Json | null
          reason: string | null
          roi_after: number | null
          roi_before: number | null
          site_id: string | null
          status: string
          unlock_confidence: number | null
          unlock_score: number | null
          user_id: string
        }
        Insert: {
          action: string
          campaign_id: string
          campaign_name?: string | null
          created_at?: string
          delivery_after?: number | null
          delivery_before?: number | null
          error?: string | null
          google_account_id?: string | null
          id?: string
          new_budget?: number | null
          new_cpa?: number | null
          old_budget?: number | null
          old_cpa?: number | null
          payload?: Json | null
          reason?: string | null
          roi_after?: number | null
          roi_before?: number | null
          site_id?: string | null
          status?: string
          unlock_confidence?: number | null
          unlock_score?: number | null
          user_id: string
        }
        Update: {
          action?: string
          campaign_id?: string
          campaign_name?: string | null
          created_at?: string
          delivery_after?: number | null
          delivery_before?: number | null
          error?: string | null
          google_account_id?: string | null
          id?: string
          new_budget?: number | null
          new_cpa?: number | null
          old_budget?: number | null
          old_cpa?: number | null
          payload?: Json | null
          reason?: string | null
          roi_after?: number | null
          roi_before?: number | null
          site_id?: string | null
          status?: string
          unlock_confidence?: number | null
          unlock_score?: number | null
          user_id?: string
        }
        Relationships: []
      }
      scale_unlock_state: {
        Row: {
          attempts: number
          base_budget: number | null
          base_cpa: number | null
          campaign_id: string
          campaign_name: string | null
          cooldown_until: string | null
          created_at: string
          current_budget: number | null
          current_cpa: number | null
          failed_at: string | null
          failed_reason: string | null
          google_account_id: string | null
          id: string
          last_action: string | null
          last_action_at: string | null
          last_ctr_pct: number | null
          last_delivery_rate: number | null
          last_roi_pct: number | null
          observe_until: string | null
          site_id: string | null
          snapshot: Json | null
          started_at: string
          status: string
          succeeded_at: string | null
          unlock_confidence: number
          unlock_score: number
          updated_at: string
          user_id: string
        }
        Insert: {
          attempts?: number
          base_budget?: number | null
          base_cpa?: number | null
          campaign_id: string
          campaign_name?: string | null
          cooldown_until?: string | null
          created_at?: string
          current_budget?: number | null
          current_cpa?: number | null
          failed_at?: string | null
          failed_reason?: string | null
          google_account_id?: string | null
          id?: string
          last_action?: string | null
          last_action_at?: string | null
          last_ctr_pct?: number | null
          last_delivery_rate?: number | null
          last_roi_pct?: number | null
          observe_until?: string | null
          site_id?: string | null
          snapshot?: Json | null
          started_at?: string
          status?: string
          succeeded_at?: string | null
          unlock_confidence?: number
          unlock_score?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          attempts?: number
          base_budget?: number | null
          base_cpa?: number | null
          campaign_id?: string
          campaign_name?: string | null
          cooldown_until?: string | null
          created_at?: string
          current_budget?: number | null
          current_cpa?: number | null
          failed_at?: string | null
          failed_reason?: string | null
          google_account_id?: string | null
          id?: string
          last_action?: string | null
          last_action_at?: string | null
          last_ctr_pct?: number | null
          last_delivery_rate?: number | null
          last_roi_pct?: number | null
          observe_until?: string | null
          site_id?: string | null
          snapshot?: Json | null
          started_at?: string
          status?: string
          succeeded_at?: string | null
          unlock_confidence?: number
          unlock_score?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      site_automation_config: {
        Row: {
          automation_dry_run: boolean
          automation_enabled: boolean
          automation_enabled_at: string | null
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
          automation_enabled_at?: string | null
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
          automation_enabled_at?: string | null
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
      site_funnel_config: {
        Row: {
          created_at: string
          funnel_dry_run: boolean
          funnel_enabled: boolean
          google_account_id: string
          id: string
          initial_budget: number
          last_run_at: string | null
          site_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          funnel_dry_run?: boolean
          funnel_enabled?: boolean
          google_account_id: string
          id?: string
          initial_budget?: number
          last_run_at?: string | null
          site_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          funnel_dry_run?: boolean
          funnel_enabled?: boolean
          google_account_id?: string
          id?: string
          initial_budget?: number
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
          last_full_sync_at: string | null
          name: string
          network_code: string
          next_sync_allowed_at: string | null
          status: string
          sync_error: string | null
          sync_lock: boolean | null
          sync_started_at: string | null
          sync_status: string
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
          last_full_sync_at?: string | null
          name: string
          network_code: string
          next_sync_allowed_at?: string | null
          status?: string
          sync_error?: string | null
          sync_lock?: boolean | null
          sync_started_at?: string | null
          sync_status?: string
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
          last_full_sync_at?: string | null
          name?: string
          network_code?: string
          next_sync_allowed_at?: string | null
          status?: string
          sync_error?: string | null
          sync_lock?: boolean | null
          sync_started_at?: string | null
          sync_status?: string
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
      sync_state: {
        Row: {
          created_at: string
          failed_accounts: string[] | null
          google_account_id: string | null
          id: string
          last_error: string | null
          last_finished_at: string | null
          last_started_at: string | null
          last_status: string
          metadata: Json | null
          rows_synced: number | null
          site_id: string | null
          source: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          failed_accounts?: string[] | null
          google_account_id?: string | null
          id?: string
          last_error?: string | null
          last_finished_at?: string | null
          last_started_at?: string | null
          last_status?: string
          metadata?: Json | null
          rows_synced?: number | null
          site_id?: string | null
          source: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          failed_accounts?: string[] | null
          google_account_id?: string | null
          id?: string
          last_error?: string | null
          last_finished_at?: string | null
          last_started_at?: string | null
          last_status?: string
          metadata?: Json | null
          rows_synced?: number | null
          site_id?: string | null
          source?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      unattributed_push_revenue: {
        Row: {
          created_at: string
          date: string
          id: string
          impressions: number
          raw_gam_row: Json | null
          reason: string
          revenue_usd: number
          site_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          date: string
          id?: string
          impressions?: number
          raw_gam_row?: Json | null
          reason?: string
          revenue_usd?: number
          site_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          date?: string
          id?: string
          impressions?: number
          raw_gam_row?: Json | null
          reason?: string
          revenue_usd?: number
          site_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accessible_sites: { Args: { _uid: string }; Returns: string[] }
      admin_has_permission: {
        Args: { _perm: string; _uid: string }
        Returns: boolean
      }
      admin_has_site_access: {
        Args: { _site: string; _uid: string }
        Returns: boolean
      }
      can_access_account: {
        Args: { _account_id: string; _uid: string }
        Returns: boolean
      }
      can_access_campaign: {
        Args: { _campaign_id: string; _uid: string }
        Returns: boolean
      }
      can_access_google_account: {
        Args: {
          _account_id: string
          _need_migrate?: boolean
          _need_sync?: boolean
          _uid: string
        }
        Returns: boolean
      }
      can_access_module: {
        Args: { _module: string; _need_edit?: boolean; _uid: string }
        Returns: boolean
      }
      can_access_site: {
        Args: { _site_id: string; _uid: string }
        Returns: boolean
      }
      effective_role: { Args: { _uid: string }; Returns: string }
      is_super_admin: { Args: { _uid: string }; Returns: boolean }
    }
    Enums: {
      app_role:
        | "super_admin"
        | "admin"
        | "media_buyer"
        | "adops"
        | "manager"
        | "viewer"
        | "site_manager"
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
    Enums: {
      app_role: [
        "super_admin",
        "admin",
        "media_buyer",
        "adops",
        "manager",
        "viewer",
        "site_manager",
      ],
    },
  },
} as const
