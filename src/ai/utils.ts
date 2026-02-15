const ET_DATETIME_FORMAT = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/New_York',
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatTimestampET(date: Date): string {
  return ET_DATETIME_FORMAT.format(date);
}
