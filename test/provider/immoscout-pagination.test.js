import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';

describe('#immoscout pagination testsuite()', () => {
  let fetchStub;
  let provider;
  let origFetch;

  beforeEach(async () => {
    fetchStub = sinon.stub();

    // Mock the provider module with mocked dependencies
    provider = await esmock('../../lib/provider/immoscout.js', {
      '../../lib/services/storage/listingsStorage.js': {
        getKnownListingHashesForJobAndProvider: () => [],
      },
      '../../lib/services/logger.js': {
        default: {
          debug: () => {},
          info: () => {},
          warn: () => {},
          error: () => {},
        },
      },
    });

    // Stub global fetch
    origFetch = global.fetch;
    global.fetch = fetchStub;
  });

  afterEach(() => {
    sinon.restore();
    global.fetch = origFetch;
  });

  it('should fetch multiple pages when new listings are found', async () => {
    // Mock fetch responses for multiple pages

    // Page 1 response with listings
    fetchStub.onCall(0).resolves({
      ok: true,
      json: async () => ({
        resultListItems: [
          {
            type: 'EXPOSE_RESULT',
            item: {
              id: '123456',
              title: 'Test Apartment 1',
              description: 'Description 1',
              attributes: [{ value: '1.200 €' }, { value: '65 m²' }],
              address: { line: 'Test Street 1, Berlin' },
              titlePicture: { preview: 'http://example.com/image1.jpg' },
            },
          },
          {
            type: 'EXPOSE_RESULT',
            item: {
              id: '123457',
              title: 'Test Apartment 2',
              description: 'Description 2',
              attributes: [{ value: '1.300 €' }, { value: '70 m²' }],
              address: { line: 'Test Street 2, Berlin' },
            },
          },
        ],
      }),
    });

    // Page 2 response with one new listing
    fetchStub.onCall(1).resolves({
      ok: true,
      json: async () => ({
        resultListItems: [
          {
            type: 'EXPOSE_RESULT',
            item: {
              id: '123458',
              title: 'Test Apartment 3',
              description: 'Description 3',
              attributes: [{ value: '1.400 €' }, { value: '75 m²' }],
              address: { line: 'Test Street 3, Berlin' },
            },
          },
        ],
      }),
    });

    // Page 3 response with no new listings (duplicate from page 2)
    fetchStub.onCall(2).resolves({
      ok: true,
      json: async () => ({
        resultListItems: [
          {
            type: 'EXPOSE_RESULT',
            item: {
              id: '123458',
              title: 'Test Apartment 3',
              description: 'Description 3',
              attributes: [{ value: '1.400 €' }, { value: '75 m²' }],
              address: { line: 'Test Street 3, Berlin' },
            },
          },
        ],
      }),
    });

    // Initialize provider without known listings
    provider.init({ enabled: true, url: 'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten' }, []);

    // Call getListings
    const listings = await provider.config.getListings(
      'https://api.mobile.immobilienscout24.de/search/list?realestatetype=apartmentrent',
    );

    // Verify results
    expect(listings).to.be.an('array');
    expect(listings).to.have.lengthOf(3);

    // Verify all three unique listings are returned (check by original listing IDs)
    const titles = listings.map((l) => l.title);
    expect(titles).to.include('Test Apartment 1');
    expect(titles).to.include('Test Apartment 2');
    expect(titles).to.include('Test Apartment 3');

    // Verify fetch was called 3 times (3 pages)
    expect(fetchStub.callCount).to.equal(3);

    // Verify correct pagination URLs were called
    expect(fetchStub.getCall(0).args[0]).to.include('pagenumber=1');
    expect(fetchStub.getCall(1).args[0]).to.include('pagenumber=2');
    expect(fetchStub.getCall(2).args[0]).to.include('pagenumber=3');
  });

  it('should stop pagination when no listings are found', async () => {
    // Page 1 response with listings
    fetchStub.onCall(0).resolves({
      ok: true,
      json: async () => ({
        resultListItems: [
          {
            type: 'EXPOSE_RESULT',
            item: {
              id: '123456',
              title: 'Test Apartment 1',
              description: 'Description 1',
              attributes: [{ value: '1.200 €' }, { value: '65 m²' }],
              address: { line: 'Test Street 1, Berlin' },
            },
          },
        ],
      }),
    });

    // Page 2 response with empty results
    fetchStub.onCall(1).resolves({
      ok: true,
      json: async () => ({
        resultListItems: [],
      }),
    });

    provider.init({ enabled: true, url: 'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten' }, []);

    const listings = await provider.config.getListings(
      'https://api.mobile.immobilienscout24.de/search/list?realestatetype=apartmentrent',
    );

    expect(listings).to.be.an('array');
    expect(listings).to.have.lengthOf(1);
    expect(listings[0].title).to.equal('Test Apartment 1');

    // Verify fetch was called only 2 times (stopped at empty page)
    expect(fetchStub.callCount).to.equal(2);
  });

  it('should handle existing pagenumber parameter in URL', async () => {
    // Mock response
    fetchStub.resolves({
      ok: true,
      json: async () => ({
        resultListItems: [],
      }),
    });

    provider.init({ enabled: true, url: 'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten' }, []);

    // Call with URL that already has pagenumber parameter
    await provider.config.getListings(
      'https://api.mobile.immobilienscout24.de/search/list?realestatetype=apartmentrent&pagenumber=5',
    );

    // Verify it starts from page 1 (ignoring the pagenumber=5)
    expect(fetchStub.getCall(0).args[0]).to.include('pagenumber=1');
    expect(fetchStub.getCall(0).args[0]).to.not.include('pagenumber=5');
  });

  it('should handle fetch errors gracefully', async () => {
    // Page 1 successful
    fetchStub.onCall(0).resolves({
      ok: true,
      json: async () => ({
        resultListItems: [
          {
            type: 'EXPOSE_RESULT',
            item: {
              id: '123456',
              title: 'Test Apartment 1',
              attributes: [{ value: '1.200 €' }, { value: '65 m²' }],
              address: { line: 'Test Street 1, Berlin' },
            },
          },
        ],
      }),
    });

    // Page 2 network error
    fetchStub.onCall(1).rejects(new Error('Network error'));

    provider.init({ enabled: true, url: 'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten' }, []);

    const listings = await provider.config.getListings(
      'https://api.mobile.immobilienscout24.de/search/list?realestatetype=apartmentrent',
    );

    // Should return listings from successful page 1
    expect(listings).to.be.an('array');
    expect(listings).to.have.lengthOf(1);
    expect(listings[0].title).to.equal('Test Apartment 1');
  });

  it('should respect maximum page limit', async () => {
    // Mock response that always returns new listings (to test the limit)
    const mockResponse = (pageNum) => ({
      ok: true,
      json: async () => ({
        resultListItems: [
          {
            type: 'EXPOSE_RESULT',
            item: {
              id: `listing-${pageNum}`,
              title: `Test Apartment ${pageNum}`,
              attributes: [{ value: '1.200 €' }, { value: '65 m²' }],
              address: { line: `Test Street ${pageNum}, Berlin` },
            },
          },
        ],
      }),
    });

    // Set up 55 mock responses (more than the 50 page limit)
    for (let i = 0; i < 55; i++) {
      fetchStub.onCall(i).resolves(mockResponse(i + 1));
    }

    provider.init({ enabled: true, url: 'https://www.immobilienscout24.de/Suche/de/berlin/berlin/wohnung-mieten' }, []);

    const listings = await provider.config.getListings(
      'https://api.mobile.immobilienscout24.de/search/list?realestatetype=apartmentrent',
    );

    // Should stop at 50 pages
    expect(fetchStub.callCount).to.equal(50);
    expect(listings).to.have.lengthOf(50);
  });
});
