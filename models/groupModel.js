import { supabase } from "../config/supabase.js";

export const createGroup = async (payload) => {
  const { data, error } = await supabase
    .from("groups")
    .insert([payload])
    .select()
    .single();

  if (error) throw error;
  return data;
};

export const bulkInsertGroupContacts = async (rows) => {
  const { data, error } = await supabase
    .from("group_contacts")
    .insert(rows)
    .select();

  if (error) throw error;
  return data;
};

export const listGroupsByUser = async (user_id) => {
  const { data, error } = await supabase
    .from("groups")
    .select("*")
    .eq("user_id", user_id)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data;
};

export const getGroupWithContacts = async (group_id) => {
  const { data: group, error } = await supabase
    .from("groups")
    .select("*")
    .eq("group_id", group_id)
    .single();

  if (error || !group) return null;

  const { data: contacts } = await supabase
    .from("group_contacts")
    .select("contact_id, full_name, phone_number, email")
    .eq("group_id", group_id);

  return {
    ...group,
    contacts: contacts || [],
  };
};
