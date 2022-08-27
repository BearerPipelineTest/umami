import { ClickHouse } from 'clickhouse';
import dateFormat from 'dateformat';
import { FILTER_IGNORED } from 'lib/constants';
import { CLICKHOUSE_DATE_FORMATS } from './constants';

function getClient() {
  if (!process.env.ANALYTICS_URL) {
    return null;
  }

  const url = new URL(process.env.ANALYTICS_URL);
  const database = url.pathname.replace('/', '');

  return new ClickHouse({
    url: url.hostname,
    port: Number(url.port),
    basicAuth: url.password
      ? {
          username: url.username || 'default',
          password: url.password,
        }
      : null,
    format: 'json',
    config: {
      database,
    },
  });
}

const clickhouse = global.clickhouse || getClient();

if (process.env.NODE_ENV !== 'production') {
  global.clickhouse = clickhouse;
}

export { clickhouse };

function getDateStringQuery(data, unit) {
  return `formatDateTime(${data}, '${CLICKHOUSE_DATE_FORMATS[unit]}')`;
}

function getDateQuery(field, unit, timezone) {
  if (timezone) {
    return `date_trunc('${unit}', ${field}, '${timezone}')`;
  }
  return `date_trunc('${unit}', ${field})`;
}

function getDateFormat(date) {
  return `'${dateFormat(date, 'UTC:yyyy-mm-dd HH:MM:ss')}'`;
}

function getBetweenDates(field, start_at, end_at) {
  return `${field} between ${getDateFormat(start_at)} 
    and ${getDateFormat(end_at)}`;
}

function getFilterQuery(table, column, filters = {}, params = []) {
  const query = Object.keys(filters).reduce((arr, key) => {
    const filter = filters[key];

    if (filter === undefined || filter === FILTER_IGNORED) {
      return arr;
    }

    switch (key) {
      case 'url':
        if (table === 'pageview' || table === 'event') {
          arr.push(`and ${table}.${key}=$${params.length + 1}`);
          params.push(decodeURIComponent(filter));
        }
        break;

      case 'os':
      case 'browser':
      case 'device':
      case 'country':
        if (table === 'session') {
          arr.push(`and ${table}.${key}=$${params.length + 1}`);
          params.push(decodeURIComponent(filter));
        }
        break;

      case 'event_name':
        if (table === 'event') {
          arr.push(`and ${table}.${key}=$${params.length + 1}`);
          params.push(decodeURIComponent(filter));
        }
        break;

      case 'referrer':
        if (table === 'pageview' || table === 'event') {
          arr.push(`and ${table}.referrer like $${params.length + 1}`);
          params.push(`%${decodeURIComponent(filter)}%`);
        }
        break;

      case 'domain':
        if (table === 'pageview') {
          arr.push(`and ${table}.referrer not like $${params.length + 1}`);
          arr.push(`and ${table}.referrer not like '/%'`);
          params.push(`%://${filter}/%`);
        }
        break;

      case 'query':
        if (table === 'pageview') {
          arr.push(`and ${table}.url like '%?%'`);
        }
    }

    return arr;
  }, []);

  return query.join('\n');
}

function parseFilters(table, column, filters = {}, params = [], sessionKey = 'session_id') {
  const { domain, url, event_url, referrer, os, browser, device, country, event_name, query } =
    filters;

  const pageviewFilters = { domain, url, referrer, query };
  const sessionFilters = { os, browser, device, country };
  const eventFilters = { url: event_url, event_name };

  return {
    pageviewFilters,
    sessionFilters,
    eventFilters,
    event: { event_name },
    joinSession:
      os || browser || device || country
        ? `inner join session on ${table}.${sessionKey} = session.${sessionKey}`
        : '',
    pageviewQuery: getFilterQuery('pageview', column, pageviewFilters, params),
    sessionQuery: getFilterQuery('session', column, sessionFilters, params),
    eventQuery: getFilterQuery('event', column, eventFilters, params),
  };
}

function replaceQuery(string, params = []) {
  let formattedString = string;

  params.forEach((a, i) => {
    let replace = a;

    if (typeof a === 'string' || a instanceof String) {
      replace = `'${replace}'`;
    }

    formattedString = formattedString.replace(`$${i + 1}`, replace);
  });

  return formattedString;
}

async function rawQuery(query, params = [], debug = false) {
  let formattedQuery = replaceQuery(query, params);

  if (debug || process.env.LOG_QUERY) {
    console.log(formattedQuery);
  }

  return clickhouse.query(formattedQuery).toPromise();
}

async function findUnique(data) {
  if (data.length > 1) {
    throw `${data.length} records found when expecting 1.`;
  }

  return data[0] ?? null;
}

async function findFirst(data) {
  return data[0] ?? null;
}

export default {
  getDateStringQuery,
  getDateQuery,
  getDateFormat,
  getBetweenDates,
  getFilterQuery,
  parseFilters,
  replaceQuery,
  rawQuery,
  findUnique,
  findFirst,
};