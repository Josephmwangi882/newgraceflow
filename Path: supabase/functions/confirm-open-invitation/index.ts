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
    const { openInvitationId, profileId } = await req.json();

    if (!openInvitationId || !profileId) {
      return new Response(JSON.stringify({ success: false, reason: "missing_params" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: invitation, error: updateError } = await supabase
      .from("open_invitations")
      .update({ status: "filled", filled_by: profileId })
      .eq("id", openInvitationId)
      .eq("status", "open")
      .select()
      .single();

    if (!invitation) {
      return new Response(JSON.stringify({ success: false, reason: "already_filled" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: ministry } = await supabase
      .from("ministries")
      .select("church_id")
      .eq("id", invitation.ministry_id)
      .single();
    const churchId = ministry?.church_id;

    const { error: assignError } = await supabase
      .from("assignments")
      .insert({
        activity_id: invitation.activity_id,
        person_id: profileId,
        church_id: churchId,
        role: invitation.role,
        status: "confirmed",
      });

    if (assignError) throw assignError;

    await supabase
      .from("notifications")
      .update({ read: true })
      .eq("reference_id", openInvitationId)
      .neq("user_id", profileId);

    const { data: profile } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", profileId)
      .single();

    const { data: activity } = await supabase
      .from("activities")
      .select("name")
      .eq("id", invitation.activity_id)
      .single();

    const userName = profile?.full_name || "Someone";
    const activityName = activity?.name || "an activity";
    const message = `${userName} has volunteered for ${activityName} as ${invitation.role}.`;

    let recipientIds: string[] = [];

    if (churchId) {
      const { data: admins } = await supabase
        .from("profiles")
        .select("id")
        .eq("church_id", churchId)
        .eq("role", "admin");

      if (admins && admins.length > 0) {
        recipientIds = admins.map((a) => a.id);
      } else {
        const { data: leaders } = await supabase
          .from("ministry_members")
          .select("person_id, profiles!inner(role)")
          .eq("ministry_id", invitation.ministry_id)
          .eq("profiles.role", "ministry_leader");

        if (leaders) {
          recipientIds = leaders.map((l) => l.person_id);
        }
      }
    }

    if (recipientIds.length > 0) {
      const notifications = recipientIds.map((id) => ({
        user_id: id,
        title: "Volunteer Confirmed",
        message,
        read: false,
      }));
      await supabase.from("notifications").insert(notifications);
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});