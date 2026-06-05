const actionUrl = String(import.meta.env.VITE_GOOGLE_FORM_ACTION_URL || '').trim();
const nameEntryId = String(import.meta.env.VITE_GOOGLE_FORM_NAME_ENTRY || '').trim();
const suggestionsEntryId = String(import.meta.env.VITE_GOOGLE_FORM_SUGGESTIONS_ENTRY || '').trim();

export const feedbackFormConfig = {
  actionUrl,
  nameEntryId,
  suggestionsEntryId,
  contactEmail: 'frontendtech01@gmail.com',
  enabled: Boolean(actionUrl && nameEntryId && suggestionsEntryId),
};
