// services/groupImportService.js
//
// Creates a contact group and bulk-inserts its contacts. Shared by:
//   - agentController.handleGroupFromCsv  (dashboard, HTTP)
//   - agents/agentTools.js create_group_from_upload  (WhatsApp assistant)
//
// Lives in its own service (rather than in agentController) so the tool layer
// can import it without a circular dependency: agentController imports
// agentTools, so agentTools must not import agentController.
//
// Throws a plain Error with an optional `status` (400 bad input / 500 DB).

import { supabase } from "../config/supabase.js";

export async function createGroupFromContacts({
  user_id,
  group_name,
  description = "",
  contacts,
  csv_url = null,
}) {
  const badInput = (msg) => Object.assign(new Error(msg), { status: 400 });
  if (!user_id) throw badInput("user_id is required");
  if (!group_name?.trim()) throw badInput("group_name is required");
  if (!contacts?.length) throw badInput("No contacts provided");

  const { data: group, error: groupErr } = await supabase
    .from("groups")
    .insert({
      user_id,
      group_name: group_name.trim(),
      description: description?.trim() || null,
      uploaded_csv: csv_url, // Supabase storage URL from preview step
      status: "active",
    })
    .select()
    .single();

  if (groupErr) {
    throw Object.assign(new Error(groupErr.message), { status: 500 });
  }

  // Bulk insert contacts — attach group_id (the preview didn't know it yet)
  const contactsWithGroup = contacts.map((c) => ({
    ...c,
    group_id: group.group_id,
    user_id,
  }));

  const BATCH = 500;
  let insertedCount = 0;

  for (let i = 0; i < contactsWithGroup.length; i += BATCH) {
    const batch = contactsWithGroup.slice(i, i + BATCH);
    const { data: inserted, error: insertErr } = await supabase
      .from("group_contacts")
      .insert(batch)
      .select("contact_id");

    if (insertErr) {
      console.error(
        `[AgentGroup] Batch insert error at offset ${i}:`,
        insertErr.message,
      );
    } else {
      insertedCount += inserted?.length ?? 0;
    }
  }

  const skipped = contacts.length - insertedCount;

  return {
    success: true,
    group_id: group.group_id,
    group_name: group.group_name,
    contacts_inserted: insertedCount,
    skipped,
    message: `Group "${group.group_name}" created with ${insertedCount} contact${insertedCount !== 1 ? "s" : ""}${skipped > 0 ? ` (${skipped} skipped)` : ""}.`,
  };
}
