// Day-one check and setup helper for the Cal.com account.
//
//   CAL_API_KEY=cal_... npm run cal:setup
//       Confirms the key works and lists event types with their ids.
//   CAL_API_KEY=... CAL_EVENT_TYPE_ID=123 BOOKING_PAGE_URL=cal.com/you/audit npm run cal:setup
//       Also checks the booking questions and reads availability.
//   ... npm run cal:setup -- --create-fields
//       Adds any missing booking questions to the event type (all optional).
//   ... npm run cal:setup -- --book you@example.com
//       Makes ONE real test booking, so you can confirm the booking call, the Meet link and the
//       reschedule and cancel links. It lands on the real calendar: cancel it afterwards.
import { createCalClient } from '../src/cal.js';
import { createCalAdmin, diffFields } from '../src/calAdmin.js';
import { loadConfig } from '../src/config.js';
import { SchedulerConflictError, SchedulerUnavailableError } from '../src/scheduler.js';

const config = loadConfig(process.env);
const args = process.argv.slice(2);

if (!config.calApiKey) {
  console.error('Set CAL_API_KEY (Cal.com: Settings, Developer, API keys).');
  process.exit(1);
}

const admin = createCalAdmin(config);

async function main() {
  const me = await admin.me();
  console.log(`Signed in as ${me.username} <${me.email}>, timezone ${me.timeZone}`);

  const types = await admin.eventTypes();
  console.log('\nEvent types:');
  for (const t of types) {
    const mark = t.id === config.calEventTypeId ? '   <-- CAL_EVENT_TYPE_ID' : '';
    console.log(
      `- [${t.id}] ${t.title} (/${t.slug}, ${t.lengthInMinutes} min, location: ${t.locations.join(', ') || 'none'}, ` +
        `min notice ${t.minimumBookingNotice ?? '?'} min, buffer after ${t.afterEventBuffer ?? '?'} min)${t.hidden ? ' HIDDEN' : ''}${mark}`,
    );
  }
  if (!config.calEventTypeId) {
    console.log('\nSet CAL_EVENT_TYPE_ID to the id of the AI Readiness Audit event type, then run this again.');
    return;
  }
  if (!types.some((t) => t.id === config.calEventTypeId)) {
    console.log(`\nWARNING: no event type with id ${config.calEventTypeId} on this account.`);
  }

  let fields = await admin.bookingFields(config.calEventTypeId);
  if (args.includes('--create-fields')) {
    const added = await admin.createMissingFields(config.calEventTypeId);
    console.log(added.length ? `\nAdded booking questions: ${added.join(', ')}` : '\nAll booking questions already exist.');
    fields = await admin.bookingFields(config.calEventTypeId);
  }
  const diff = diffFields(config, fields);
  console.log('\nBooking questions the connector fills in:');
  console.log(diff.missing.length ? `  MISSING: ${diff.missing.join(', ')}  (run with --create-fields)` : '  all present');
  if (diff.requiredButUnfilled.length) {
    console.log(`  WARNING: required questions the connector never answers: ${diff.requiredButUnfilled.join(', ')}. Bookings will be rejected. Make them optional.`);
  }
  if (!config.bookingPageUrl) console.log('\nSet BOOKING_PAGE_URL (for example cal.com/yourname/audit); written-audit replies link to it.');

  const scheduler = createCalClient(config);
  const from = new Date(Date.now() + 60_000);
  const times = await scheduler.availableTimes(from, new Date(from.getTime() + 14 * 86_400_000));
  console.log(`\nAvailability, next 14 days: ${times.length} open slots${times[0] ? ` (first: ${times[0].toISOString()})` : ''}`);
  if (times.length === 0) console.log('  None found. Check the event type schedule, minimum notice and that the event is not hidden.');

  const bookIdx = args.indexOf('--book');
  if (bookIdx === -1) {
    console.log('\nNext: run with "--book you@example.com" to make one real test booking.');
    return;
  }
  const email = args[bookIdx + 1];
  if (!email || !times[0]) throw new Error('Need an email after --book and at least one open slot.');
  const f = config.calFields;
  const b = await scheduler.createBooking({
    start: times[0],
    name: 'Connector Test (cancel me)',
    email,
    timezone: 'America/Los_Angeles',
    source: 'test',
    fields: {
      [f.business]: 'Connector test',
      [f.website]: 'Not provided',
      [f.city]: 'Redondo Beach',
      [f.industry]: 'Other',
      [f.painPoint]: 'Testing the connector',
      [f.phone]: 'Not provided',
      [f.channel]: 'All of it',
    },
  });
  console.log(`\nBOOKED ${times[0].toISOString()}  uid ${b.uid}`);
  console.log(`  Meet link:   ${b.meetLink ?? '(not in the response; check the invite email)'}`);
  console.log(`  Reschedule:  ${b.rescheduleUrl}`);
  console.log(`  Cancel:      ${b.cancelUrl}`);
  console.log('\nOpen the reschedule and cancel links. If either is a 404, set RESCHEDULE_URL_TEMPLATE / CANCEL_URL_TEMPLATE to the working pattern (use {uid}).');
  console.log('Then cancel this test booking.');
}

main().catch((e) => {
  if (e instanceof SchedulerUnavailableError) console.error(`\nFAILED (${e.kind}): ${e.message}`);
  else if (e instanceof SchedulerConflictError) console.error('\nThat slot was taken. Run again.');
  else console.error(e);
  process.exit(1);
});
