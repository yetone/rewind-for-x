// Serves the site from ./site; www.rewindforx.com redirects to the bare domain.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === 'www.rewindforx.com') {
      url.hostname = 'rewindforx.com';
      return Response.redirect(url.toString(), 301);
    }
    return env.ASSETS.fetch(request);
  },
};
