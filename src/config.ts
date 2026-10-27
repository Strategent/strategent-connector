export interface Config {
  baseUrl: string;
  signingSecret: string;
  calApiKey: string;
  calApiBase: string;
  calEventTypeId: number;
  /** Cal.com location integration to book, for example "google-meet". Blank uses the event type default. */
  calLocation: string;
  calFields: CalFieldSlugs;
  /** Public pages for a booking. {uid} is replaced with the booking uid. */
  rescheduleUrlTemplate: string;
  cancelUrlTemplate: string;
  /** Where someone can book a time themselves, shown in written-audit replies. */
  bookingPageUrl: string;
  /** Shared secret Cal.com signs webhook deliveries with. Blank turns the webhook endpoint off. */
  calWebhookSecret: string;
  supabaseUrl: string;
  supabaseServiceKey: string;
  slackWebhookUrl: string;
  resendApiKey: string;
  notifyEmailTo: string;
  notifyEmailFrom: string;
  sendRequesterAck: boolean;
  privacyUrl: string;
  termsUrl: string;
  hostIntro: string;
  allowedRedirectHosts: string[];
  bookingHourlyCap: number;
  perEmailDailyCap: number;
  writtenOpenCap: number;
}

/** Slugs of the booking questions on the Cal.com event type. Answers are keyed by these. */
export interface CalFieldSlugs {
  business: string;
  website: string;
  city: string;
  industry: string;
  painPoint: string;
  phone: string;
  channel: string;
}

type Env = Record<string, string | undefined>;

const int = (v: string | undefined, d: number) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

export function loadConfig(env: Env): Config {
  const baseUrl = (env.PUBLIC_BASE_URL ?? 'https://connect.strategent.app').replace(/\/+$/, '');
  return {
    baseUrl,
    signingSecret: env.SIGNING_SECRET ?? '',
    calApiKey: env.CAL_API_KEY ?? '',
    calApiBase: (env.CAL_API_BASE ?? 'https://api.cal.com').replace(/\/+$/, ''),
    calEventTypeId: int(env.CAL_EVENT_TYPE_ID, 0),
    calLocation: env.CAL_LOCATION ?? 'google-meet',
    calFields: {
      business: env.CAL_FIELD_BUSINESS ?? 'business-name',
      website: env.CAL_FIELD_WEBSITE ?? 'website',
      city: env.CAL_FIELD_CITY ?? 'city',
      industry: env.CAL_FIELD_INDUSTRY ?? 'industry',
      painPoint: env.CAL_FIELD_PAIN ?? 'pain-point',
      phone: env.CAL_FIELD_PHONE ?? 'phone',
      channel: env.CAL_FIELD_CHANNEL ?? 'channel-interest',
    },
    rescheduleUrlTemplate: env.RESCHEDULE_URL_TEMPLATE ?? 'https://cal.com/reschedule/{uid}',
    cancelUrlTemplate: env.CANCEL_URL_TEMPLATE ?? 'https://cal.com/booking/{uid}?cancel=true',
    bookingPageUrl: (env.BOOKING_PAGE_URL ?? '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    calWebhookSecret: env.CAL_WEBHOOK_SECRET ?? '',
    supabaseUrl: (env.SUPABASE_URL ?? '').replace(/\/+$/, ''),
    supabaseServiceKey: env.SUPABASE_SERVICE_KEY ?? '',
    slackWebhookUrl: env.SLACK_WEBHOOK_URL ?? '',
    resendApiKey: env.RESEND_API_KEY ?? '',
    notifyEmailTo: env.NOTIFY_EMAIL_TO ?? 'info@strategent.app',
    notifyEmailFrom: env.NOTIFY_EMAIL_FROM ?? 'Strategent Connector <connector@strategent.app>',
    sendRequesterAck: env.SEND_REQUESTER_ACK === 'true',
    privacyUrl: env.PRIVACY_URL ?? 'https://www.strategent.app/privacy-policy',
    termsUrl: env.TERMS_URL ?? 'https://www.strategent.app/terms-of-service',
    hostIntro: env.HOST_INTRO ?? 'Ruchi Singh, co-founder of Strategent',
    allowedRedirectHosts: (env.ALLOWED_REDIRECT_HOSTS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    bookingHourlyCap: int(env.BOOKING_HOURLY_CAP, 20),
    perEmailDailyCap: int(env.PER_EMAIL_DAILY_CAP, 3),
    writtenOpenCap: int(env.WRITTEN_OPEN_CAP, 10),
  };
}

/** Returns the names of required settings that are missing. */
export function missingConfig(c: Config): string[] {
  const missing: string[] = [];
  if (c.signingSecret.length < 32) missing.push('SIGNING_SECRET (32+ chars)');
  if (!c.calApiKey) missing.push('CAL_API_KEY');
  if (!c.calEventTypeId) missing.push('CAL_EVENT_TYPE_ID');
  if (!c.bookingPageUrl) missing.push('BOOKING_PAGE_URL (for example cal.com/yourname/audit)');
  if (!c.supabaseUrl) missing.push('SUPABASE_URL');
  if (!c.supabaseServiceKey) missing.push('SUPABASE_SERVICE_KEY');
  return missing;
}
