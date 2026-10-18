// Blog sources for https://grepawk.com/blog (scripts/build-blog.mjs). Each repo opts posts in from
// its own top-level `blog/<slug>/index.md` with `publish: true` front matter; docs/ is never read.
// All four repos are public, so CI reads them over anonymous HTTPS (no token).
export const SITE = 'https://grepawk.com';
export const BLOG_URL = `${SITE}/blog`;
export const AUTHOR = 'Yisheng Jiang';

// product id -> how a post links to the app. Only ProTune is live on the App Store today; the others
// link to their websites until a live store URL exists (verify with the iTunes lookup API first).
export const PRODUCTS = {
  finalcap: { name: 'FinalCap', accent: '#8b7cf6', accent2: '#5b8def', cta: 'Try FinalCap in your browser', url: 'https://grepawk.com/' },
  protune: { name: 'ProTune AI Camera', accent: '#f5b83d', accent2: '#f0743e', cta: 'Get ProTune AI Camera on the App Store', url: 'https://apps.apple.com/us/app/protune-ai-camera/id6813991381', site: 'https://photo.grepawk.com/' },
  'ai-music-radar': { name: 'AI Music Radar', accent: '#ff7a59', accent2: '#e9469a', cta: 'See AI Music Radar', url: 'https://music.grepawk.com/' },
  'music-reader': { name: 'AI Camera - Music Reader', short: 'Music Reader', accent: '#2dd4bf', accent2: '#3b9cf0', cta: 'Music Reader support and source', url: 'https://grepawk.com/music-reader/support.html' },
};

export const SOURCES = [
  { name: 'finalcut', repo: 'yishengjiang99/finalcut', local: true },
  { name: 'photo-recipes', repo: 'yishengjiang99/photo-recipes', articles: true },
  { name: 'earsheet', repo: 'yishengjiang99/earsheet' },
  { name: 'omr-sheet-cam', repo: 'yishengjiang99/omr-sheet-cam' },
];

// photo-recipes articles stay canonical on photo.grepawk.com; /blog only links out to them.
export const PHOTO_ARTICLES_BASE = 'https://photo.grepawk.com/articles';
