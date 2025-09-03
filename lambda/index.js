/* eslint-disable  no-console */

const Alexa = require('ask-sdk-core');
var https = require('https');
const fetch = require('node-fetch');


const SKILL_NAME = 'Device Address';
const FALLBACK_MESSAGE = `The ${SKILL_NAME} skill can't help you with that.  It can help skills to request and access the configured address in the customer’s device settings if you where am I located. What can I help you with?`;
const FALLBACK_REPROMPT = 'What can I help you with?';

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const N8N_API_KEY     = process.env.N8N_API_KEY || '';
const N8N_TIMEOUT_MS  = Number(process.env.N8N_TIMEOUT_MS || 2500);

const DEFAULT_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 5000);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 2);
const TARGET_URL = process.env.TARGET_URL || "https://online.cheshireeast.gov.uk/MyCollectionDay/SearchByAjax/GetBartecJobList?uprn=200001125216&onelineaddress=16%20THORNE%20TREE%20DRIVE,%20CW1%204UA&_=1755248588972";


const messages = {
  WELCOME: 'Welcome to the Sample Device Address API Skill!  You can ask for the device address by saying what is my address.  What do you want to ask?',
  WHAT_DO_YOU_WANT: 'What do you want to ask?',
  NOTIFY_MISSING_PERMISSIONS: 'Please enable Location permissions in the Amazon Alexa app.',
  NO_ADDRESS: 'It looks like you don\'t have an address set. You can set your address from the companion app.',
  ADDRESS_AVAILABLE: 'Here is your full address: ',
  ERROR: 'Uh Oh. Looks like something went wrong.',
  LOCATION_FAILURE: 'There was an error with the Device Address API. Please try again.',
  GOODBYE: 'Bye! Thanks for using the Sample Device Address API Skill!',
  UNHANDLED: 'This skill doesn\'t support that. Please ask something else.',
  HELP: 'You can use this skill by asking something like: whats my address?',
  STOP: 'Bye! Thanks for using the Sample Device Address API Skill!',
};

const PERMISSIONS = ['read::alexa:device:all:address'];

const LaunchRequest = {
  canHandle(handlerInput) {
    return handlerInput.requestEnvelope.request.type === 'LaunchRequest';
  },
  handle(handlerInput) {
    console.log('Inside LaunchRequestHandler');
    //const binDataResponse =  httpGetBinCollectionData();
    
    const url = TARGET_URL;
    
    console.log("About to fetch result");

    return fetch(url, {
      method: "GET",
      // Example for POST:
      // method: "POST",
      // headers: { "content-type": "application/json" },
      // body: JSON.stringify({ foo: "bar" }),
    })
    .then(res => {
      const isJson = (res.headers.get('content-type') || '').includes('application/json');
      return (isJson ? res.json() : res.text()).then(body => ({ res, isJson, body }));
    })
    .then(({ res, isJson, body }) => {
      const parsed = isJson ? body : parseNextCollections(body);
      console.log("PARSED: " + JSON.stringify(parsed));
      const bins = parsed.bins.join(' and ');
      const binDate = parsed.date;
      console.log(bins);
      console.log(binDate);
      const speechText = `Your next collection is ${bins} on ${binDate}.`;

      return handlerInput.responseBuilder
        .speak(speechText)
        .withSimpleCard('Bin collections', speechText)
        .getResponse();
    })
    .catch(err => {
      console.error('Fetch/parse failed:', err);
      return handlerInput.responseBuilder
        .speak("Sorry, I'm having trouble reaching the service right now.")
        .reprompt("Want me to try again?")
        .getResponse();
    });
  },
};

// Helper: basic exponential backoff retry for 5xx/Network errors
function fetchWithRetry(url, options = {}) {
  let attempt = 0;
  let lastErr;

  while (attempt <= MAX_RETRIES) {
    try {
      const res = fetchWithTimeout(url, options);
      // Retry on 5xx; treat others as final
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        return res;
      }
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }

    attempt += 1;
    if (attempt > MAX_RETRIES) break;

    // Exponential backoff: 200ms, 400ms, 800ms, ...
    const backoff = 200 * 2 ** (attempt - 1);
    sleep(backoff);
  }

  throw lastErr || new Error("Unknown fetch error");
}

// Helper: sleep
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Helper: fetch with timeout
async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  //const ctrl = new AbortController();
  const id = setTimeout(() => timeoutMs);
  try {
    const res = fetch(url, { options });
    return res;
  } finally {
    clearTimeout(id);
  }
}

// Process html response to extract bin days
function parseNextCollections(htmlString) {
console.log(htmlString);
  // 1) Parse the visible rows: <tr class="data-row ..."><label>...</label>...</tr>
  const rowRegex = /<tr class="data-row ([^"]+)"[^>]*>([\s\S]*?)<\/tr>/gi;
  const entries = [];
  let rowMatch;

  while ((rowMatch = rowRegex.exec(htmlString)) !== null) {
    const className  = rowMatch[1];      // e.g. recyclable-bin-type
    const rowContent = rowMatch[2];

    // pull out all <label> values inside the row
    const labelRegex = /<label[^>]*>([^<]*)<\/label>/gi;
    const labels = [];
    let m;
    while ((m = labelRegex.exec(rowContent)) !== null) {
      labels.push(m[1].trim());
    }

    // expected: [Day, Date, Description]
    if (labels.length >= 3) {
      const dateStr = labels[1]; // e.g. "18/08/2025"
      const ts = toTimestamp(dateStr);
      if (!Number.isNaN(ts)) {
        entries.push({ className, dateStr, ts });
      }
    }
  }

  // If nothing matched (or you prefer), fall back to the hidden inputs block
  if (entries.length === 0) {
    // Each job is a <tr class="data-row ..."> with hidden inputs including ScheduledStart and JobDescription
    const hiddenRowRegex = /<tr class="data-row ([^"]+)"[^>]*>([\s\S]*?)<\/tr>/gi;
    let h;
    while ((h = hiddenRowRegex.exec(htmlString)) !== null) {
      const className  = h[1];
      const rowContent = h[2];

      // ScheduledStart like value="18/08/2025 07:00:00"
      const startMatch = /name="BartecSimplifiedJobList\[\d+\]\.ScheduledStart"[^>]*value="([^"]+)"/i.exec(rowContent);
      // JobDescription like value="Empty 240L SILVER"
      const descMatch  = /name="BartecSimplifiedJobList\[\d+\]\.JobDescription"[^>]*value="([^"]+)"/i.exec(rowContent);

      if (startMatch) {
        const datePart = startMatch[1].split(' ')[0]; // "DD/MM/YYYY"
        const ts = toTimestamp(datePart);
        if (!Number.isNaN(ts)) {
          entries.push({ className, dateStr: datePart, ts });
        }
      }
      // we don’t strictly need descMatch for the date, but you could use it as a colour fallback
    }
  }

  if (entries.length === 0) {
    return { date: null, bins: [] }; // nothing found
  }

  // Sort by numeric timestamps (earliest first)
  entries.sort((a, b) => a.ts - b.ts);

  // Earliest date:
  const earliestTs  = entries[0].ts;
  const earliestStr = entries[0].dateStr;

  // All rows that share the earliest date:
  const todays = entries.filter(e => e.ts === earliestTs);

  // Map CSS classes to colours (fallback to class name if unknown)
  const classToColor = {
    'recyclable-bin-type': 'silver',
    'green-waste-bin-type': 'green',
    'non-recyclable-bin-type': 'black'
  };
  const bins = todays.map(e => classToColor[e.className] || e.className);

  // De-duplicate colours just in case
  const uniqueBins = [...new Set(bins)];

  console.log(earliestStr);

  return { date: earliestStr, bins: uniqueBins };
}

function toTimestamp(ddmmyyyy) {
  // dd/mm/yyyy -> numeric timestamp
  const [d, m, y] = ddmmyyyy.split('/').map(Number);
  return new Date(y, m - 1, d).getTime();
}

// const GetAddressIntent = {
//   canHandle(handlerInput) {
//     const { request } = handlerInput.requestEnvelope;

//     return request.type === 'IntentRequest' && request.intent.name === 'GetAddressIntent';
//   },
//   async handle(handlerInput) {
//     const { requestEnvelope, serviceClientFactory, responseBuilder } = handlerInput;

//     const consentToken = requestEnvelope.context.System.user.permissions
//       && requestEnvelope.context.System.user.permissions.consentToken;
//     if (!consentToken) {
//       return responseBuilder
//         .speak(messages.NOTIFY_MISSING_PERMISSIONS)
//         .withAskForPermissionsConsentCard(PERMISSIONS)
//         .getResponse();
//     }
//     try {
//       const { deviceId } = requestEnvelope.context.System.device;
//       const deviceAddressServiceClient = serviceClientFactory.getDeviceAddressServiceClient();
//       const address = deviceAddressServiceClient.getFullAddress(deviceId);

//       console.log('Address successfully retrieved, now responding to user.');

//       let response;
//       if (address.addressLine1 === null && address.stateOrRegion === null) {
//         response = responseBuilder.speak(messages.NO_ADDRESS).getResponse();
//       } else {
//         const ADDRESS_MESSAGE = `${messages.ADDRESS_AVAILABLE + address.addressLine1}, ${address.stateOrRegion}, ${address.postalCode}`;
//         response = responseBuilder.speak(ADDRESS_MESSAGE).getResponse();
//       }
//       return response;
//     } catch (error) {
//       if (error.name !== 'ServiceError') {
//         const response = responseBuilder.speak(messages.ERROR).getResponse();
//         return response;
//       }
//       throw error;
//     }
//   },
// };

const SessionEndedRequest = {
  canHandle(handlerInput) {
    return handlerInput.requestEnvelope.request.type === 'SessionEndedRequest';
  },
  handle(handlerInput) {
    console.log(`Session ended with reason: ${handlerInput.requestEnvelope.request.reason}`);

    return handlerInput.responseBuilder.getResponse();
  },
};

const UnhandledIntent = {
  canHandle() {
    return true;
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak(messages.UNHANDLED)
      .reprompt(messages.UNHANDLED)
      .getResponse();
  },
};

const HelpIntent = {
  canHandle(handlerInput) {
    const { request } = handlerInput.requestEnvelope;

    return request.type === 'IntentRequest' && request.intent.name === 'AMAZON.HelpIntent';
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak(messages.HELP)
      .reprompt(messages.HELP)
      .getResponse();
  },
};

const CancelIntent = {
  canHandle(handlerInput) {
    const { request } = handlerInput.requestEnvelope;

    return request.type === 'IntentRequest' && request.intent.name === 'AMAZON.CancelIntent';
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak(messages.GOODBYE)
      .getResponse();
  },
};

const StopIntent = {
  canHandle(handlerInput) {
    const { request } = handlerInput.requestEnvelope;

    return request.type === 'IntentRequest' && request.intent.name === 'AMAZON.StopIntent';
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak(messages.STOP)
      .getResponse();
  },
};

const GetAddressError = {
  canHandle(handlerInput, error) {
    return error.name === 'ServiceError';
  },
  handle(handlerInput, error) {
    if (error.statusCode === 403) {
      return handlerInput.responseBuilder
        .speak(messages.NOTIFY_MISSING_PERMISSIONS)
        .withAskForPermissionsConsentCard(PERMISSIONS)
        .getResponse();
    }
    return handlerInput.responseBuilder
      .speak(messages.LOCATION_FAILURE)
      .reprompt(messages.LOCATION_FAILURE)
      .getResponse();
  },
};

const FallbackHandler = {
  // 2018-May-01: AMAZON.FallackIntent is only currently available in en-US locale.
  //              This handler will not be triggered except in that locale, so it can be
  //              safely deployed for any locale.
  canHandle(handlerInput) {
    const request = handlerInput.requestEnvelope.request;
    return request.type === 'IntentRequest'
      && request.intent.name === 'AMAZON.FallbackIntent';
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak(FALLBACK_MESSAGE)
      .reprompt(FALLBACK_REPROMPT)
      .getResponse();
  },
};

const GlobalErrorHandler = {
  canHandle(handlerInput, error) {
    // handle all type of exceptions
    // Note : To filter on certain type of exceptions use error.type property
    return true;
  },
  handle(handlerInput, error) {
    // Log Error
    console.log("==== ERROR ======");
    console.log(error);
    // Respond back to Alexa
    const speechText = "I'm sorry, I didn't catch that. Could you rephrase ?";
    return handlerInput.responseBuilder
      .speak(speechText)
      .reprompt(speechText)
      .getResponse();
  },
};

const skillBuilder = Alexa.SkillBuilders.custom();

exports.handler = skillBuilder
  .addRequestHandlers(
    LaunchRequest,
    //GetAddressIntent,
    SessionEndedRequest,
    HelpIntent,
    CancelIntent,
    StopIntent,
    FallbackHandler,
    UnhandledIntent,
  )
  .addErrorHandlers(GetAddressError, GlobalErrorHandler)
  .withApiClient(new Alexa.DefaultApiClient())
  .lambda();