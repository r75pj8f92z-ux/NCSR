// Netlify Functions entry: every /api/* request (rewritten by netlify.toml) runs the same
// Express app that the local server and the Vercel entry use. Netlify invokes this function
// at /.netlify/functions/app/*, so we strip that prefix before handing the path to Express,
// which still expects routes starting with /api/...
import serverlessHttp from 'serverless-http';
import app from '../../app.js';

const handleRequest = serverlessHttp(app);
const PREFIX = '/.netlify/functions/app';

export const handler = async (event, context) => {
  if (event.path.startsWith(PREFIX)) {
    event.path = event.path.slice(PREFIX.length) || '/';
  }
  return handleRequest(event, context);
};
