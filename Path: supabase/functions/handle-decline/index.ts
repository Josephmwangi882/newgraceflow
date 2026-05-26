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
    const { assignmentId, profileId, activityId, ministryId, role } = await req.json();

    if (!assignmentId || !profileId || !activityId || !ministryId || !role) {
      return new Response(JSON.stringify({ success: false, reason: "missing_params" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 400,
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { error: updateError } = await supabase
      .from("assignments")
      .update({ status: "declined" })
      .eq("id", assignmentId);

    if (updateError) throw updateError;

    const { data: ministry } = await supabase
      .from("ministries")
      .select("church_id")
      .eq("id", ministryId)
      .single();
    const churchId = ministry?.church_id;

    const { data: members } = await supabase
      .from("ministry_members")
      .select("person_id")
      .eq("ministry_id", ministryId)
      .neq("person_id", profileId);

    const eligibleProfileIds = (members || []).map((m) => m.person_id);

    const notifyAdminNoVolunteers = async () => {
      const { data: activity } = await supabase
        .from("activities")
        .select("name")
        .eq("id", activityId)
        .single();
      const activityName = activity?.name || "an activity";

      if (churchId) {
        const { data: admin } = await supabase
          .from("profiles")
          .select("id")
          .eq("church_id", churchId)
          .eq("role", "admin")
          .limit(1)
          .single();

        if (admin) {
          await supabase.from("notifications").insert({
            user_id: admin.id,
            title: "Volunteer Needed",
            message: `No available volunteers for ${activityName}. Please assign manually.`,
            read: false,
          });
        }
      }
    };

    if (eligibleProfileIds.length === 0) {
      await notifyAdminNoVolunteers();
      return new Response(JSON.stringify({ success: true, openInvitationCreated: false }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: existing } = await supabase
      .from("assignments")
      .select("person_id")
      .eq("activity_id", activityId)
      .in("status", ["confirmed", "pending"])
      .in("person_id", eligibleProfileIds);

    const assignedIds = (existing || []).map((a) => a.person_id);
    const finalEligible = eligibleProfileIds.filter((id) => !assignedIds.includes(id));

    if (finalEligible.length === 0) {
      await notifyAdminNoVolunteers();
      return new Response(JSON.stringify({ success: true, openInvitationCreated: false }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: newInvitation } = await supabase
      .from("open_invitations")
      .insert({
        activity_id: activityId,
        ministry_id: ministryId,
        role: role,
        status: "open",
      })
      .select("id")
      .single();

    if (!newInvitation) {
      throw new Error("Failed to create open invitation");
    }

    const { data: activity } = await supabase
      .from("activities")
      .select("name")
      .eq("id", activityId)
      .single();
    const activityName = activity?.name || "an activity";

    const notifications = finalEligible.map((pid) => ({
      user_id: pid,
      title: "Open Invitation",
      message: `${activityName} needs a ${role}. Tap to volunteer.`,
      reference_id: newInvitation.id,
      read: false,
    }));

    await supabase.from("notifications").insert(notifications);

    return new Response(JSON.stringify({ success: true, openInvitationCreated: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});