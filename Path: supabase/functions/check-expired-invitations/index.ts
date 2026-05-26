import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { churchId } = await req.json();

    if (!churchId) {
      return new Response(JSON.stringify({ success: false, reason: "missing_params" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const now = new Date().toISOString();

    const { data: expired, error } = await supabase
      .from("open_invitations")
      .select("id, activity_id, role")
      .eq("status", "open")
      .lt("expires_at", now);

    if (error) throw error;

    if (!expired || expired.length === 0) {
      return new Response(JSON.stringify({ expired: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const ids = expired.map((i) => i.id);
    await supabase
      .from("open_invitations")
      .update({ status: "expired" })
      .in("id", ids);

    const activityIds = [...new Set(expired.map((i) => i.activity_id))];
    const { data: activities } = await supabase
      .from("activities")
      .select("id, name")
      .in("id", activityIds);
    const activityMap: Record<string, string> = {};
    (activities || []).forEach((a) => {
      activityMap[a.id] = a.name;
    });

    const { data: admins } = await supabase
      .from("profiles")
      .select("id")
      .eq("church_id", churchId)
      .eq("role", "admin");

    if (admins && admins.length > 0) {
      const adminIds = admins.map((a) => a.id);
      const notifications = [];
      for (const inv of expired) {
        const activityName = activityMap[inv.activity_id] || "Unknown activity";
        const message = `${activityName} still needs a ${inv.role}. No one has responded.`;
        for (const adminId of adminIds) {
          notifications.push({
            user_id: adminId,
            title: "Invitation Expired",
            message,
            read: false,
          });
        }
      }
      await supabase.from("notifications").insert(notifications);
    }

    return new Response(JSON.stringify({ expired: expired.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});