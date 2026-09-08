// AUTO-GENERATED FILE. DO NOT EDIT BY HAND.
// Regenerate with: npm run db:types
// Source: local Supabase Postgres schema (npx supabase gen types typescript --local)

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      app_users: {
        Row: {
          created_at: string
          driver_id: string | null
          id: string
          is_active: boolean
          resort_id: string | null
          role: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          driver_id?: string | null
          id: string
          is_active?: boolean
          resort_id?: string | null
          role: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          driver_id?: string | null
          id?: string
          is_active?: boolean
          resort_id?: string | null
          role?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "app_users_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "app_users_resort_id_fkey"
            columns: ["resort_id"]
            isOneToOne: false
            referencedRelation: "resorts"
            referencedColumns: ["id"]
          },
        ]
      }
      attendance: {
        Row: {
          actual_end: string | null
          actual_start: string | null
          created_at: string
          driver_id: string
          id: string
          notes: string | null
          recorded_at: string
          recorded_by: string | null
          resort_id: string
          shift_instance_id: string
          status: string
          updated_at: string
        }
        Insert: {
          actual_end?: string | null
          actual_start?: string | null
          created_at?: string
          driver_id: string
          id?: string
          notes?: string | null
          recorded_at?: string
          recorded_by?: string | null
          resort_id: string
          shift_instance_id: string
          status: string
          updated_at?: string
        }
        Update: {
          actual_end?: string | null
          actual_start?: string | null
          created_at?: string
          driver_id?: string
          id?: string
          notes?: string | null
          recorded_at?: string
          recorded_by?: string | null
          resort_id?: string
          shift_instance_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_driver_resort_fk"
            columns: ["driver_id", "resort_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id", "resort_id"]
          },
          {
            foreignKeyName: "attendance_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_shift_instance_resort_fk"
            columns: ["shift_instance_id", "resort_id"]
            isOneToOne: false
            referencedRelation: "driver_visible_assignments"
            referencedColumns: ["shift_instance_id", "resort_id"]
          },
          {
            foreignKeyName: "attendance_shift_instance_resort_fk"
            columns: ["shift_instance_id", "resort_id"]
            isOneToOne: false
            referencedRelation: "driver_visible_shifts"
            referencedColumns: ["id", "resort_id"]
          },
          {
            foreignKeyName: "attendance_shift_instance_resort_fk"
            columns: ["shift_instance_id", "resort_id"]
            isOneToOne: false
            referencedRelation: "shift_instances"
            referencedColumns: ["id", "resort_id"]
          },
          {
            foreignKeyName: "attendance_shift_instance_resort_fk"
            columns: ["shift_instance_id", "resort_id"]
            isOneToOne: false
            referencedRelation: "v_refreshable_instances"
            referencedColumns: ["shift_instance_id", "resort_id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          actor_role: string | null
          actor_source: string
          actor_user_id: string | null
          after: Json | null
          before: Json | null
          changed_fields: string[] | null
          id: string
          occurred_at: string
          row_id: string
          table_name: string
        }
        Insert: {
          action: string
          actor_role?: string | null
          actor_source: string
          actor_user_id?: string | null
          after?: Json | null
          before?: Json | null
          changed_fields?: string[] | null
          id?: string
          occurred_at?: string
          row_id: string
          table_name: string
        }
        Update: {
          action?: string
          actor_role?: string | null
          actor_source?: string
          actor_user_id?: string | null
          after?: Json | null
          before?: Json | null
          changed_fields?: string[] | null
          id?: string
          occurred_at?: string
          row_id?: string
          table_name?: string
        }
        Relationships: []
      }
      availability: {
        Row: {
          answered_at: string
          created_at: string
          driver_id: string
          id: string
          resort_id: string
          shift_instance_id: string
          status: string
          updated_at: string
        }
        Insert: {
          answered_at?: string
          created_at?: string
          driver_id: string
          id?: string
          resort_id: string
          shift_instance_id: string
          status: string
          updated_at?: string
        }
        Update: {
          answered_at?: string
          created_at?: string
          driver_id?: string
          id?: string
          resort_id?: string
          shift_instance_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "availability_driver_resort_fk"
            columns: ["driver_id", "resort_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id", "resort_id"]
          },
          {
            foreignKeyName: "availability_shift_instance_resort_fk"
            columns: ["shift_instance_id", "resort_id"]
            isOneToOne: false
            referencedRelation: "driver_visible_assignments"
            referencedColumns: ["shift_instance_id", "resort_id"]
          },
          {
            foreignKeyName: "availability_shift_instance_resort_fk"
            columns: ["shift_instance_id", "resort_id"]
            isOneToOne: false
            referencedRelation: "driver_visible_shifts"
            referencedColumns: ["id", "resort_id"]
          },
          {
            foreignKeyName: "availability_shift_instance_resort_fk"
            columns: ["shift_instance_id", "resort_id"]
            isOneToOne: false
            referencedRelation: "shift_instances"
            referencedColumns: ["id", "resort_id"]
          },
          {
            foreignKeyName: "availability_shift_instance_resort_fk"
            columns: ["shift_instance_id", "resort_id"]
            isOneToOne: false
            referencedRelation: "v_refreshable_instances"
            referencedColumns: ["shift_instance_id", "resort_id"]
          },
        ]
      }
      availability_submissions: {
        Row: {
          created_at: string
          driver_id: string
          id: string
          reopened_at: string | null
          reopened_reason: string | null
          resort_id: string
          shift_count_at_submission: number
          submitted_at: string | null
          updated_at: string
          week_start: string
        }
        Insert: {
          created_at?: string
          driver_id: string
          id?: string
          reopened_at?: string | null
          reopened_reason?: string | null
          resort_id: string
          shift_count_at_submission?: number
          submitted_at?: string | null
          updated_at?: string
          week_start: string
        }
        Update: {
          created_at?: string
          driver_id?: string
          id?: string
          reopened_at?: string | null
          reopened_reason?: string | null
          resort_id?: string
          shift_count_at_submission?: number
          submitted_at?: string | null
          updated_at?: string
          week_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "availability_submissions_driver_resort_fk"
            columns: ["driver_id", "resort_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id", "resort_id"]
          },
        ]
      }
      driver_onfleet_mappings: {
        Row: {
          created_at: string
          driver_id: string
          id: string
          is_active: boolean
          onfleet_worker_id: string
          resort_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          driver_id: string
          id?: string
          is_active?: boolean
          onfleet_worker_id: string
          resort_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          driver_id?: string
          id?: string
          is_active?: boolean
          onfleet_worker_id?: string
          resort_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "driver_onfleet_mappings_driver_resort_fk"
            columns: ["driver_id", "resort_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id", "resort_id"]
          },
        ]
      }
      drivers: {
        Row: {
          created_at: string
          full_name: string
          id: string
          is_active: boolean
          resort_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          full_name: string
          id?: string
          is_active?: boolean
          resort_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          full_name?: string
          id?: string
          is_active?: boolean
          resort_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "drivers_resort_id_fkey"
            columns: ["resort_id"]
            isOneToOne: false
            referencedRelation: "resorts"
            referencedColumns: ["id"]
          },
        ]
      }
      payroll_adjustments: {
        Row: {
          amount_chf: number
          created_at: string
          created_by: string | null
          date: string
          description: string | null
          driver_id: string
          id: string
          resort_id: string
          shift_instance_id: string | null
          type: string
          updated_at: string
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          amount_chf: number
          created_at?: string
          created_by?: string | null
          date: string
          description?: string | null
          driver_id: string
          id?: string
          resort_id: string
          shift_instance_id?: string | null
          type: string
          updated_at?: string
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          amount_chf?: number
          created_at?: string
          created_by?: string | null
          date?: string
          description?: string | null
          driver_id?: string
          id?: string
          resort_id?: string
          shift_instance_id?: string | null
          type?: string
          updated_at?: string
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payroll_adjustments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payroll_adjustments_driver_resort_fk"
            columns: ["driver_id", "resort_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id", "resort_id"]
          },
          {
            foreignKeyName: "payroll_adjustments_shift_instance_resort_fk"
            columns: ["shift_instance_id", "resort_id"]
            isOneToOne: false
            referencedRelation: "driver_visible_assignments"
            referencedColumns: ["shift_instance_id", "resort_id"]
          },
          {
            foreignKeyName: "payroll_adjustments_shift_instance_resort_fk"
            columns: ["shift_instance_id", "resort_id"]
            isOneToOne: false
            referencedRelation: "driver_visible_shifts"
            referencedColumns: ["id", "resort_id"]
          },
          {
            foreignKeyName: "payroll_adjustments_shift_instance_resort_fk"
            columns: ["shift_instance_id", "resort_id"]
            isOneToOne: false
            referencedRelation: "shift_instances"
            referencedColumns: ["id", "resort_id"]
          },
          {
            foreignKeyName: "payroll_adjustments_shift_instance_resort_fk"
            columns: ["shift_instance_id", "resort_id"]
            isOneToOne: false
            referencedRelation: "v_refreshable_instances"
            referencedColumns: ["shift_instance_id", "resort_id"]
          },
          {
            foreignKeyName: "payroll_adjustments_voided_by_fkey"
            columns: ["voided_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      resorts: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          name: string
          slug: string
          timezone: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          slug: string
          timezone?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          slug?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
      rota_assignments: {
        Row: {
          assigned_at: string
          assigned_by: string | null
          assignment_source: string
          created_at: string
          driver_id: string
          id: string
          resort_id: string
          shift_instance_id: string
          updated_at: string
        }
        Insert: {
          assigned_at?: string
          assigned_by?: string | null
          assignment_source: string
          created_at?: string
          driver_id: string
          id?: string
          resort_id: string
          shift_instance_id: string
          updated_at?: string
        }
        Update: {
          assigned_at?: string
          assigned_by?: string | null
          assignment_source?: string
          created_at?: string
          driver_id?: string
          id?: string
          resort_id?: string
          shift_instance_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rota_assignments_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rota_assignments_driver_resort_fk"
            columns: ["driver_id", "resort_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id", "resort_id"]
          },
          {
            foreignKeyName: "rota_assignments_shift_instance_resort_fk"
            columns: ["shift_instance_id", "resort_id"]
            isOneToOne: false
            referencedRelation: "driver_visible_assignments"
            referencedColumns: ["shift_instance_id", "resort_id"]
          },
          {
            foreignKeyName: "rota_assignments_shift_instance_resort_fk"
            columns: ["shift_instance_id", "resort_id"]
            isOneToOne: false
            referencedRelation: "driver_visible_shifts"
            referencedColumns: ["id", "resort_id"]
          },
          {
            foreignKeyName: "rota_assignments_shift_instance_resort_fk"
            columns: ["shift_instance_id", "resort_id"]
            isOneToOne: false
            referencedRelation: "shift_instances"
            referencedColumns: ["id", "resort_id"]
          },
          {
            foreignKeyName: "rota_assignments_shift_instance_resort_fk"
            columns: ["shift_instance_id", "resort_id"]
            isOneToOne: false
            referencedRelation: "v_refreshable_instances"
            referencedColumns: ["shift_instance_id", "resort_id"]
          },
        ]
      }
      rota_publications: {
        Row: {
          created_at: string
          generation_source: string
          id: string
          published_at: string
          published_by: string | null
          resort_id: string
          unpublished_at: string | null
          updated_at: string
          week_start: string
        }
        Insert: {
          created_at?: string
          generation_source: string
          id?: string
          published_at?: string
          published_by?: string | null
          resort_id: string
          unpublished_at?: string | null
          updated_at?: string
          week_start: string
        }
        Update: {
          created_at?: string
          generation_source?: string
          id?: string
          published_at?: string
          published_by?: string | null
          resort_id?: string
          unpublished_at?: string | null
          updated_at?: string
          week_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "rota_publications_published_by_fkey"
            columns: ["published_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rota_publications_resort_id_fkey"
            columns: ["resort_id"]
            isOneToOne: false
            referencedRelation: "resorts"
            referencedColumns: ["id"]
          },
        ]
      }
      shift_instances: {
        Row: {
          base_pay_chf: number
          cancelled_at: string | null
          cancelled_by: string | null
          cancelled_reason: string | null
          created_at: string
          date: string
          delivery_rate_chf: number
          end_time: string
          id: string
          is_premium: boolean
          name: string
          origin: string
          required_drivers: number
          resort_id: string
          shift_key: string
          shift_type_id: string
          sort_order: number
          start_time: string
          status: string
          template_id: string | null
          updated_at: string
          week_start: string | null
        }
        Insert: {
          base_pay_chf: number
          cancelled_at?: string | null
          cancelled_by?: string | null
          cancelled_reason?: string | null
          created_at?: string
          date: string
          delivery_rate_chf: number
          end_time: string
          id?: string
          is_premium?: boolean
          name: string
          origin: string
          required_drivers: number
          resort_id: string
          shift_key: string
          shift_type_id: string
          sort_order: number
          start_time: string
          status?: string
          template_id?: string | null
          updated_at?: string
          week_start?: string | null
        }
        Update: {
          base_pay_chf?: number
          cancelled_at?: string | null
          cancelled_by?: string | null
          cancelled_reason?: string | null
          created_at?: string
          date?: string
          delivery_rate_chf?: number
          end_time?: string
          id?: string
          is_premium?: boolean
          name?: string
          origin?: string
          required_drivers?: number
          resort_id?: string
          shift_key?: string
          shift_type_id?: string
          sort_order?: number
          start_time?: string
          status?: string
          template_id?: string | null
          updated_at?: string
          week_start?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shift_instances_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_instances_resort_id_fkey"
            columns: ["resort_id"]
            isOneToOne: false
            referencedRelation: "resorts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_instances_shift_type_resort_fk"
            columns: ["shift_type_id", "resort_id"]
            isOneToOne: false
            referencedRelation: "shift_types"
            referencedColumns: ["id", "resort_id"]
          },
          {
            foreignKeyName: "shift_instances_template_shift_type_fk"
            columns: ["template_id", "shift_type_id"]
            isOneToOne: false
            referencedRelation: "shift_templates"
            referencedColumns: ["id", "shift_type_id"]
          },
        ]
      }
      shift_templates: {
        Row: {
          base_pay_chf: number
          created_at: string
          delivery_rate_chf: number
          effective_from: string
          effective_to: string | null
          end_time: string
          id: string
          is_active: boolean
          is_premium: boolean
          required_drivers: number
          resort_id: string
          shift_type_id: string
          start_time: string
          updated_at: string
          weekday: number
        }
        Insert: {
          base_pay_chf: number
          created_at?: string
          delivery_rate_chf: number
          effective_from: string
          effective_to?: string | null
          end_time: string
          id?: string
          is_active?: boolean
          is_premium?: boolean
          required_drivers: number
          resort_id: string
          shift_type_id: string
          start_time: string
          updated_at?: string
          weekday: number
        }
        Update: {
          base_pay_chf?: number
          created_at?: string
          delivery_rate_chf?: number
          effective_from?: string
          effective_to?: string | null
          end_time?: string
          id?: string
          is_active?: boolean
          is_premium?: boolean
          required_drivers?: number
          resort_id?: string
          shift_type_id?: string
          start_time?: string
          updated_at?: string
          weekday?: number
        }
        Relationships: [
          {
            foreignKeyName: "shift_templates_shift_type_resort_fk"
            columns: ["shift_type_id", "resort_id"]
            isOneToOne: false
            referencedRelation: "shift_types"
            referencedColumns: ["id", "resort_id"]
          },
        ]
      }
      shift_types: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          key: string
          name: string
          resort_id: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          key: string
          name: string
          resort_id: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          key?: string
          name?: string
          resort_id?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shift_types_resort_id_fkey"
            columns: ["resort_id"]
            isOneToOne: false
            referencedRelation: "resorts"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      driver_visible_assignments: {
        Row: {
          assignment_id: string | null
          date: string | null
          end_time: string | null
          name: string | null
          resort_id: string | null
          shift_instance_id: string | null
          shift_key: string | null
          start_time: string | null
          week_start: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shift_instances_resort_id_fkey"
            columns: ["resort_id"]
            isOneToOne: false
            referencedRelation: "resorts"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_visible_shifts: {
        Row: {
          date: string | null
          end_time: string | null
          id: string | null
          name: string | null
          resort_id: string | null
          shift_key: string | null
          shift_type_id: string | null
          sort_order: number | null
          start_time: string | null
          status: string | null
          week_start: string | null
        }
        Insert: {
          date?: string | null
          end_time?: string | null
          id?: string | null
          name?: string | null
          resort_id?: string | null
          shift_key?: string | null
          shift_type_id?: string | null
          sort_order?: number | null
          start_time?: string | null
          status?: string | null
          week_start?: string | null
        }
        Update: {
          date?: string | null
          end_time?: string | null
          id?: string | null
          name?: string | null
          resort_id?: string | null
          shift_key?: string | null
          shift_type_id?: string | null
          sort_order?: number | null
          start_time?: string | null
          status?: string | null
          week_start?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shift_instances_resort_id_fkey"
            columns: ["resort_id"]
            isOneToOne: false
            referencedRelation: "resorts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_instances_shift_type_resort_fk"
            columns: ["shift_type_id", "resort_id"]
            isOneToOne: false
            referencedRelation: "shift_types"
            referencedColumns: ["id", "resort_id"]
          },
        ]
      }
      v_refreshable_instances: {
        Row: {
          current_base_pay_chf: number | null
          current_delivery_rate_chf: number | null
          current_end_time: string | null
          current_is_premium: boolean | null
          current_name: string | null
          current_required_drivers: number | null
          current_sort_order: number | null
          current_start_time: string | null
          current_template_id: string | null
          date: string | null
          governing_template_id: string | null
          new_base_pay_chf: number | null
          new_delivery_rate_chf: number | null
          new_end_time: string | null
          new_is_premium: boolean | null
          new_name: string | null
          new_required_drivers: number | null
          new_sort_order: number | null
          new_start_time: string | null
          resort_id: string | null
          shift_instance_id: string | null
          shift_key: string | null
          shift_type_id: string | null
          week_start: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shift_instances_resort_id_fkey"
            columns: ["resort_id"]
            isOneToOne: false
            referencedRelation: "resorts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_instances_shift_type_resort_fk"
            columns: ["shift_type_id", "resort_id"]
            isOneToOne: false
            referencedRelation: "shift_types"
            referencedColumns: ["id", "resort_id"]
          },
          {
            foreignKeyName: "shift_instances_template_shift_type_fk"
            columns: ["current_template_id", "shift_type_id"]
            isOneToOne: false
            referencedRelation: "shift_templates"
            referencedColumns: ["id", "shift_type_id"]
          },
        ]
      }
    }
    Functions: {
      app_weekday: { Args: { d: string }; Returns: number }
      apply_template_cancellation: {
        Args: {
          p_reason?: string
          p_resort_id: string
          p_shift_type_id?: string
        }
        Returns: {
          cancelled_count: number
          cancelled_shift_instance_ids: string[]
        }[]
      }
      apply_template_refresh: {
        Args: { p_from_date?: string; p_resort_id: string }
        Returns: {
          overassigned_count: number
          overassigned_shift_instance_ids: string[]
          reopened_submission_count: number
          updated_count: number
        }[]
      }
      assert_active_manager: { Args: never; Returns: undefined }
      confirm_availability_week: {
        Args: { p_driver_id: string; p_week_start: string }
        Returns: {
          answered_count: number
          missing_shift_ids: string[]
          resort_id: string
          result: Database["public"]["Enums"]["confirm_week_result"]
          submitted_at: string
          total_shifts: number
          week_start: string
        }[]
      }
      current_app_user: {
        Args: never
        Returns: Database["public"]["CompositeTypes"]["app_user_context"]
        SetofOptions: {
          from: "*"
          to: "app_user_context"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      current_driver_id: { Args: never; Returns: string }
      current_driver_resort_id: { Args: never; Returns: string }
      end_of_following_month: { Args: { d?: string }; Returns: string }
      is_active_driver: { Args: never; Returns: boolean }
      is_active_manager: { Args: never; Returns: boolean }
      materialise_shift_instances: {
        Args: { p_from_date?: string; p_resort_id: string; p_to_date?: string }
        Returns: {
          created_count: number
          from_date: string
          skipped_existing_count: number
          to_date: string
        }[]
      }
      preview_template_cancellation: {
        Args: { p_resort_id: string; p_shift_type_id?: string }
        Returns: {
          assignment_count: number
          date: string
          has_attendance: boolean
          has_availability_answers: boolean
          is_published: boolean
          is_safe_to_cancel: boolean
          name: string
          shift_instance_id: string
          shift_key: string
          shift_type_id: string
        }[]
      }
      preview_template_refresh: {
        Args: { p_from_date?: string; p_resort_id: string }
        Returns: {
          assignment_count: number
          changed_fields: Json
          current_required_drivers: number
          current_template_id: string
          date: string
          name: string
          new_required_drivers: number
          new_template_id: string
          shift_instance_id: string
          shift_key: string
          shift_type_id: string
          time_would_change: boolean
          will_change: boolean
          would_be_overassigned: boolean
        }[]
      }
      reopen_availability_week: {
        Args: { p_driver_id: string; p_week_start: string }
        Returns: {
          reopened_at: string
          reopened_reason: string
          resort_id: string
          result: Database["public"]["Enums"]["reopen_week_result"]
          week_start: string
        }[]
      }
      reopen_stale_submissions: {
        Args: { p_reason: string; p_resort_id: string; p_week_start: string }
        Returns: number
      }
      shift_instance_week_is_published: {
        Args: { p_shift_instance_id: string }
        Returns: boolean
      }
      week_availability_status: {
        Args: { p_driver_id: string; p_week_start: string }
        Returns: {
          answered_count: number
          missing_count: number
          missing_shift_ids: string[]
          resort_id: string
          state: Database["public"]["Enums"]["week_availability_state"]
          total_shifts: number
          week_start: string
        }[]
      }
    }
    Enums: {
      confirm_week_result: "confirmed" | "incomplete" | "locked"
      reopen_week_result: "reopened" | "locked" | "not_submitted"
      week_availability_state:
        | "locked"
        | "no_shifts"
        | "complete"
        | "incomplete"
    }
    CompositeTypes: {
      app_user_context: {
        auth_user_id: string | null
        role: string | null
        driver_id: string | null
        resort_id: string | null
        is_active: boolean | null
      }
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      confirm_week_result: ["confirmed", "incomplete", "locked"],
      reopen_week_result: ["reopened", "locked", "not_submitted"],
      week_availability_state: [
        "locked",
        "no_shifts",
        "complete",
        "incomplete",
      ],
    },
  },
} as const

