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
      gam_placement_revenue: {
        Row: {
          campaign_id: string
          created_at: string
          date: string
          id: string
          impressions: number
          placement: string
          revenue_usd: number
          site_id: string | null
          source: string | null
          user_id: string
        }
        Insert: {
          campaign_id: string
          created_at?: string
          date: string
          id?: string
          impressions?: number
          placement: string
          revenue_usd?: number
          site_id?: string | null
          source?: string | null
          user_id: string
        }
        Update: {
          campaign_id?: string
          created_at?: string
          date?: string
          id?: string
          impressions?: number
          placement?: string
          revenue_usd?: number
          site_id?: string | null
          source?: string | null
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
          auto_boost_enabled: boolean
          auto_pause_enabled: boolean
          boost_roi_pct: number
          budget_increase_pct: number
          max_loss_roi_pct: number
          min_roi_pct: number
          min_spend_threshold: number
          updated_at: string
          user_id: string
        }
        Insert: {
          analysis_days?: number
          auto_boost_enabled?: boolean
          auto_pause_enabled?: boolean
          boost_roi_pct?: number
          budget_increase_pct?: number
          max_loss_roi_pct?: number
          min_roi_pct?: number
          min_spend_threshold?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          analysis_days?: number
          auto_boost_enabled?: boolean
          auto_pause_enabled?: boolean
          boost_roi_pct?: number
          budget_increase_pct?: number
          max_loss_roi_pct?: number
          min_roi_pct?: number
          min_spend_threshold?: number
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
