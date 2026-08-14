import { supabase } from "./supabase";
import type { RealtimeChannel } from "@supabase/supabase-js";

/*
 * Realtime helpers for Postgres changes.
 *
 * subscribeToSchemaChanges() — listens to ALL changes in the `public`
 * schema (no table filter).
 *
 * subscribeToTable("my_table", cb) — listens to changes on one table.
 *
 * Both return a RealtimeChannel; clean up with:
 *   supabase.removeChannel(channel);
 */
export type TableChangePayload = {
  table: string;
  schema: string;
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: Record<string, unknown>;
  old: Record<string, unknown>;
};

export function subscribeToSchemaChanges(
  onEvent?: (payload: TableChangePayload) => void
): RealtimeChannel {
  return supabase
    .channel("public")
    .on(
      "postgres_changes",
      { event: "*", schema: "public" },
      (payload) => {
        console.log("Change received!", payload);
        onEvent?.(payload as unknown as TableChangePayload);
      }
    )
    .subscribe();
}

export function subscribeToTable(
  table: string,
  onEvent?: (payload: TableChangePayload) => void
): RealtimeChannel {
  return supabase
    .channel(`public:${table}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table },
      (payload) => {
        console.log("Change received!", payload);
        onEvent?.(payload as unknown as TableChangePayload);
      }
    )
    .subscribe();
}
