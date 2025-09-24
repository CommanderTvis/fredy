/**
 * ImmoScout provider using the mobile API to retrieve listings.
 *
 * The mobile API provides the following endpoints:
 * - GET /search/total?{search parameters}: Returns the total number of listings for the given query
 *   Example: `curl -H "User-Agent: ImmoScout_27.3_26.0_._" https://api.mobile.immobilienscout24.de/search/total?searchType=region&realestatetype=apartmentrent&pricetype=calculatedtotalrent&geocodes=%2Fde%2Fberlin%2Fberlin `
 *
 * - POST /search/list?{search parameters}: Actually retrieves the listings. Body is json encoded and contains
 *   data specifying additional results (advertisements) to return. The format is as follows:
 *   ```
 *   {
 *   "supportedResultListTypes": [],
 *   "userData": {}
 *   }
 *   ```
 *   It is not necessary to provide data for the specified keys.
 *
 *   Example: `curl -X POST 'https://api.mobile.immobilienscout24.de/search/list?pricetype=calculatedtotalrent&realestatetype=apartmentrent&searchType=region&geocodes=%2Fde%2Fberlin%2Fberlin&pagenumber=1' -H "Connection: keep-alive" -H "User-Agent: ImmoScout_27.3_26.0_._" -H "Accept: application/json" -H "Content-Type: application/json" -d '{"supportedResultListType": [], "userData": {}}'`

 * - GET /expose/{id} - Returns the details of a listing. The response contains additional details not included in the
 *   listing response.
 *
 *   Example: `curl -H "User-Agent: ImmoScout_27.3_26.0_._" "https://api.mobile.immobilienscout24.de/expose/158382494"`
 *
 *
 * It is necessary to set the correct User Agent (see `getListings`) in the request header.
 *
 * Note that the mobile API is not publicly documented. I've reverse-engineered
 * it by intercepting traffic from an android emulator running the immoscout app.
 * Moreover, the search parameters differ slightly from the web API. I've mapped them
 * to the web API parameters by comparing a search request with all parameters set between
 * the web and mobile API. The mobile API actually seems to be a superset of the web API,
 * but I have decided not to include new parameters as I wanted to keep the existing UX (i.e.,
 * users only have to provide a link to an existing search).
 *
 */

import { buildHash, isOneOf, sleep } from '../utils.js';
import {
  convertImmoscoutListingToMobileListing,
  convertWebToMobile,
} from '../services/immoscout/immoscout-web-translator.js';
import logger from '../services/logger.js';
import { getKnownListingHashesForJobAndProvider } from '../services/storage/listingsStorage.js';
let appliedBlackList = [];
let currentJobKey = null;
let currentProviderId = null;

async function fetchSinglePage(url) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': 'ImmoScout_27.3_26.0_._',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      supportedResultListTypes: [],
      userData: {},
    }),
  });
  if (!response.ok) {
    logger.error('Error fetching data from ImmoScout Mobile API:', response.statusText);
    return [];
  }

  const responseBody = await response.json();
  return responseBody.resultListItems
    .filter((item) => item.type === 'EXPOSE_RESULT')
    .map((expose) => {
      const item = expose.item;
      const [price, size] = item.attributes;
      const image = item?.titlePicture?.preview ?? null;
      return {
        id: item.id,
        price: price?.value,
        size: size?.value,
        title: item.title,
        description: item.description,
        link: `${metaInformation.baseUrl}expose/${item.id}`,
        address: item.address?.line,
        image,
      };
    });
}

async function getListings(url) {
  // Remove any existing pagenumber parameter and start from page 1
  const baseUrl = url.replace(/[&?]pagenumber=\d+/gi, '');
  const separator = baseUrl.includes('?') ? '&' : '?';

  let allListings = [];
  let currentPage = 1;
  let hasNewListings = true;

  // Get known listing hashes to detect new listings during pagination
  const hasKeys =
    typeof currentJobKey === 'string' &&
    currentJobKey.length > 0 &&
    typeof currentProviderId === 'string' &&
    currentProviderId.length > 0;
  const knownHashes = hasKeys ? getKnownListingHashesForJobAndProvider(currentJobKey, currentProviderId) : [];

  while (hasNewListings) {
    const pageUrl = `${baseUrl}${separator}pagenumber=${currentPage}`;

    try {
      const pageListings = await fetchSinglePage(pageUrl);

      // If no listings on the page, we've reached the empty page
      if (pageListings.length === 0) {
        break;
      }

      // Normalize listings to get their hash IDs
      const normalizedPageListings = pageListings.map(normalize);

      // Check if there are any new listings on this page
      const newListingsOnPage = normalizedPageListings.filter(
        (listing) => !knownHashes.includes(listing.id) && !allListings.some((existing) => existing.id === listing.id),
      );

      // Add only listings we haven't already collected in this session
      // This prevents duplicates when the same listing appears on multiple pages
      // Use the original ID from the API response for deduplication
      const uniquePageListings = pageListings.filter(
        (listing) => !allListings.some((existing) => existing.id === listing.id),
      );
      allListings = allListings.concat(uniquePageListings);

      if (newListingsOnPage.length === 0) {
        hasNewListings = false;
      } else {
        currentPage++;

        // Delay to avoid rate limiting
        await sleep(500);
      }

      // Safety limit to prevent potential bot detection
      if (currentPage > 20) {
        logger.warn('Reached maximum page limit (20) for ImmobilienScout24, stopping pagination');
        break;
      }
    } catch (error) {
      logger.error(`Error fetching page ${currentPage}:`, error);
      break;
    }
  }

  return allListings;
}

async function isListingActive(link) {
  const result = await fetch(convertImmoscoutListingToMobileListing(link), {
    headers: {
      'User-Agent': 'ImmoScout_27.3_26.0_._',
    },
  });

  if (result.status === 200) {
    return 1;
  }

  if (result.status === 404) {
    return 0;
  }

  logger.warn('Unknown status for immoscout listing', link);
  return -1;
}

function nullOrEmpty(val) {
  return val == null || val.length === 0;
}
function normalize(o) {
  const title = nullOrEmpty(o.title) ? 'NO TITLE FOUND' : o.title.replace('NEU', '');
  const address = nullOrEmpty(o.address) ? 'NO ADDRESS FOUND' : (o.address || '').replace(/\(.*\),.*$/, '').trim();
  const id = buildHash(o.id, o.price);
  return Object.assign(o, { id, title, address });
}
function applyBlacklist(o) {
  return !isOneOf(o.title, appliedBlackList);
}
const config = {
  url: null,
  crawlFields: {
    id: 'id',
    title: 'title',
    price: 'price',
    size: 'size',
    link: 'link',
    address: 'address',
  },
  // Not required - used by filter to remove and listings that failed to parse
  sortByDateParam: 'sorting=-firstactivation',
  normalize: normalize,
  filter: applyBlacklist,
  getListings: getListings,
  activeTester: isListingActive,
};
export const init = (sourceConfig, blacklist, jobKey = null, providerId = null) => {
  config.enabled = sourceConfig.enabled;
  config.url = convertWebToMobile(sourceConfig.url);
  appliedBlackList = blacklist || [];
  currentJobKey = jobKey;
  currentProviderId = providerId || metaInformation.id;
};
export const metaInformation = {
  name: 'Immoscout',
  baseUrl: 'https://www.immobilienscout24.de/',
  id: 'immoscout',
};

export { config };
