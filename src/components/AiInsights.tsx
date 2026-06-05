import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  ClipboardCopy,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Play,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import { apiFetch, apiUrl } from '../lib/api';
import { resolveImagePreviewUrl } from '../lib/imageAsset';
import { SmartProgressPanel, extractionMessages } from './ProgressExperience';

type Asset = {
  url: string;
  remote_url?: string;
  preview_url?: string;
  alt?: string;
  title?: string;
  poster?: string;
  cachedUrl?: string;
};

type BriefSlide = {
  layout: 'image-text' | 'video-gallery' | string;
  heading: string;
  body?: string;
  cta?: string;
  image?: Asset | null;
  media_assets?: Asset[];
};

type BriefTab = {
  id: number;
  label: string;
  layout: string;
  heading?: string;
  subheading?: string;
  cta?: string;
  hero_video?: Asset | null;
  hero_image?: Asset | null;
  slides?: BriefSlide[];
};

type CreativeInsights = {
  heading: string;
  hero_images: Asset[];
  hero_videos?: Asset[];
  main_focus: string;
  main_focus_cards?: Array<{ title?: string; text: string }>;
  features: string[];
  feature_cards?: Array<{ title?: string; text: string; quote?: string }>;
  testimonials: string[];
  testimonial_cards?: Array<{ quote: string; name?: string }>;
  gallery_assets?: Asset[];
  videos?: Asset[];
  brief_tabs?: BriefTab[];
  indication?: string;
  indication_source_url?: string;
  important_safety_information?: string;
  important_safety_information_source_url?: string;
};

const emptyInsights: CreativeInsights = {
  heading: '',
  hero_images: [],
  hero_videos: [],
  main_focus: '',
  features: [],
  testimonials: [],
  gallery_assets: [],
  videos: [],
  brief_tabs: [],
  indication: '',
  important_safety_information: '',
};

const isEmbeddableVideoUrl = (value: string) =>
  /youtube|youtu\.be|vimeo|wistia|vidyard|loom|brightcove/i.test(value);

export default function AiInsights({
  url,
  preloadedInsights = null,
  fallbackAssets = null,
}: {
  url: string;
  preloadedInsights?: CreativeInsights | null;
  fallbackAssets?: { images?: any[]; videos?: any[] } | null;
}) {
  const [insights, setInsights] = useState<CreativeInsights | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [briefTabIndex, setBriefTabIndex] = useState(0);
  const [briefSlideIndex, setBriefSlideIndex] = useState(0);

  const imageLookup = useMemo(() => {
    const map = new Map<string, string>();
    for (const img of fallbackAssets?.images || []) {
      const remote = String(img?.url || '').trim();
      const cached = String(img?.cachedUrl || '').trim();
      if (remote && cached) map.set(remote, cached);
    }
    return map;
  }, [fallbackAssets]);

  const resolveBriefImageSrc = (asset?: Asset | null) => {
    const remote = String(asset?.remote_url || asset?.url || '').trim();
    if (!remote) return '';
    const preview = String(asset?.preview_url || imageLookup.get(remote) || '').trim();
    if (preview.startsWith('/cached-images-original/')) return apiUrl(preview);
    if (preview.startsWith('http://') || preview.startsWith('https://')) return preview;
    return resolveImagePreviewUrl({ url: remote, cachedUrl: preview || undefined });
  };

  const parseApiBody = async (response: Response) => {
    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();
    if (contentType.includes('application/json')) {
      try {
        return JSON.parse(text);
      } catch {
        return { error: 'Server returned invalid JSON.' };
      }
    }
    return { error: text || 'Unexpected server response.' };
  };

  const data = useMemo(() => insights || emptyInsights, [insights]);

  const briefTabs = useMemo(() => {
    if (data.brief_tabs?.length) return data.brief_tabs;
    return buildBriefTabsFromInsights(data, imageLookup);
  }, [data, imageLookup]);

  const activeBriefTab = briefTabs[briefTabIndex] || briefTabs[0];

  const fetchInsights = async () => {
    if (!url) return;
    setLoading(true);
    setError(null);
    setCopied(false);

    try {
      const response = await apiFetch('/api/insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          assets: fallbackAssets ? { images: fallbackAssets.images || [] } : undefined,
        }),
      });

      const body = await parseApiBody(response);
      if (!response.ok) {
        throw new Error(body.error || 'Failed to extract creative brief');
      }
      setInsights(body);
    } catch (err: any) {
      const fallback = buildFallbackInsights(url, fallbackAssets);
      if (fallback) {
        setInsights(fallback);
        setError(null);
      } else {
        setError(err.message || 'Failed to extract creative brief.');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (preloadedInsights) {
      setInsights(preloadedInsights);
      return;
    }
    fetchInsights();
  }, [url, preloadedInsights]);

  useEffect(() => {
    setBriefTabIndex(0);
    setBriefSlideIndex(0);
  }, [url, briefTabs.length]);

  useEffect(() => {
    setBriefSlideIndex(0);
  }, [briefTabIndex]);

  const copyText = async () => {
    const lines: string[] = [];
    briefTabs.forEach((tab) => {
      lines.push(`${tab.label}`);
      if (tab.layout === 'hero-video') {
        lines.push(`Heading: ${tab.heading || ''}`);
        if (tab.subheading) lines.push(`Subheading: ${tab.subheading}`);
        if (tab.cta) lines.push(`CTA: ${tab.cta}`);
      } else {
        (tab.slides || []).forEach((slide, idx) => {
          lines.push(`Slide ${idx + 1}: ${slide.heading}`);
          if (slide.body) lines.push(slide.body);
          if (slide.cta) lines.push(`CTA: ${slide.cta}`);
        });
      }
      lines.push('');
    });
    if (data.indication) {
      lines.push('INDICATION');
      lines.push(data.indication);
      lines.push('');
    }
    if (data.important_safety_information) {
      lines.push('IMPORTANT SAFETY INFORMATION');
      lines.push(data.important_safety_information);
    }
    await navigator.clipboard.writeText(lines.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  if (loading) {
    return (
      <div className="space-y-3">
        <SmartProgressPanel
          active
          mode="extract"
          title="Building Creative Brief"
          detail="Extracting tab content, hero media, indication, and safety information"
          messages={extractionMessages}
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-red-50 text-red-800 border border-red-200 rounded-xl flex items-start gap-3">
        <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
        <div>
          <p className="font-medium">Creative Brief extraction failed</p>
          <p className="text-sm mt-1">{error}</p>
          <button onClick={fetchInsights} className="mt-3 px-4 py-2 bg-blue-600 text-white hover:bg-blue-700 rounded-lg text-sm font-medium transition-colors">
            Try Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 scroll-smooth">
      <section className="bg-white border border-zinc-200 rounded-2xl p-6 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-50 rounded-full flex items-center justify-center">
              <Sparkles className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-zinc-900">Creative Brief</h3>
              <p className="text-sm text-zinc-500">Tab 1–3 creative content with indication and safety information.</p>
            </div>
          </div>
          <button onClick={copyText} className="inline-flex items-center justify-center gap-2 bg-blue-600 text-white px-4 py-2.5 rounded-xl font-medium text-sm hover:bg-blue-700 transition-colors">
            {copied ? <Check className="w-4 h-4" /> : <ClipboardCopy className="w-4 h-4" />}
            {copied ? 'Copied' : 'Copy Brief'}
          </button>
        </div>
      </section>

      {briefTabs.length > 0 && activeBriefTab && (
        <section className="rounded-2xl bg-white border border-zinc-200 p-6 shadow-sm">
          <div className="flex flex-wrap gap-2 mb-4">
            {briefTabs.map((tab, idx) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setBriefTabIndex(idx)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${idx === briefTabIndex ? 'bg-blue-600 text-white' : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'}`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-50">
            {activeBriefTab.layout === 'hero-video' ? (
              <div className="relative">
                <div className="relative aspect-video bg-zinc-900">
                  <BriefHeroMedia
                    heroVideo={activeBriefTab.hero_video}
                    heroImage={activeBriefTab.hero_image}
                    resolveImageSrc={resolveBriefImageSrc}
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-zinc-950/80 via-zinc-950/20 to-transparent pointer-events-none" />
                  <div className="absolute inset-x-0 bottom-0 p-6 text-white pointer-events-none">
                    <h3 className="text-2xl md:text-4xl font-bold leading-tight">{activeBriefTab.heading}</h3>
                    {activeBriefTab.subheading && (
                      <p className="mt-2 text-sm md:text-base text-zinc-100 max-w-3xl">{activeBriefTab.subheading}</p>
                    )}
                    {activeBriefTab.cta && (
                      <span className="mt-4 inline-flex rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold">{activeBriefTab.cta}</span>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              (() => {
                const slides = (activeBriefTab.slides || []).filter((slide) => slide.heading || slide.body || slide.image?.url || (slide.media_assets || []).length);
                if (!slides.length) {
                  return (
                    <div className="p-8 text-center text-sm text-zinc-500">
                      No slide content extracted for this tab.
                    </div>
                  );
                }
                const activeSlide = slides[briefSlideIndex] || slides[0];
                return (
                  <div className="p-6">
                    <div className="overflow-hidden rounded-xl bg-white border border-zinc-200 shadow-sm">
                      {activeSlide.layout === 'video-gallery' && (activeSlide.media_assets || []).length > 0 ? (
                        <BriefVideoGallery assets={activeSlide.media_assets || []} resolveImageSrc={resolveBriefImageSrc} />
                      ) : (
                        <BriefImage asset={activeSlide.image} resolveImageSrc={resolveBriefImageSrc} />
                      )}
                      <div className="p-6">
                        <h3 className="text-2xl font-bold text-zinc-900">{activeSlide.heading}</h3>
                        {activeSlide.body && <p className="mt-3 text-sm leading-7 text-zinc-700 whitespace-pre-wrap">{activeSlide.body}</p>}
                        {activeSlide.cta && (
                          <span className="mt-4 inline-flex rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white">{activeSlide.cta}</span>
                        )}
                      </div>
                    </div>
                    {slides.length > 1 && (
                      <div className="mt-4 flex items-center justify-between">
                        <button
                          type="button"
                          onClick={() => setBriefSlideIndex((prev) => (prev - 1 + slides.length) % slides.length)}
                          className="inline-flex items-center gap-2 bg-blue-600 text-white px-3 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
                        >
                          <ChevronLeft className="w-4 h-4" />
                          Prev
                        </button>
                        <div className="flex items-center gap-2 rounded-full bg-white/90 px-3 py-2 shadow-sm ring-1 ring-zinc-200">
                          {slides.map((_, idx) => (
                            <button
                              key={idx}
                              type="button"
                              onClick={() => setBriefSlideIndex(idx)}
                              className={`h-3 w-3 rounded-full border transition-colors ${
                                idx === briefSlideIndex
                                  ? 'border-blue-600 bg-blue-600 shadow-[0_0_0_3px_rgba(37,99,235,0.16)]'
                                  : 'border-zinc-300 bg-white hover:border-zinc-500'
                              }`}
                              aria-label={`Go to slide ${idx + 1}`}
                              aria-current={idx === briefSlideIndex ? 'true' : undefined}
                            />
                          ))}
                        </div>
                        <button
                          type="button"
                          onClick={() => setBriefSlideIndex((prev) => (prev + 1) % slides.length)}
                          className="inline-flex items-center gap-2 bg-blue-600 text-white px-3 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
                        >
                          Next
                          <ChevronRight className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })()
            )}
          </div>
        </section>
      )}

      {data.indication ? (
        <section className="rounded-2xl border-2 border-emerald-300 bg-emerald-50 p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center">
              <AlertCircle className="w-5 h-5 text-emerald-700" />
            </div>
            <div>
              <h4 className="text-lg font-semibold text-emerald-950">Indication</h4>
              <p className="text-sm text-emerald-800">Exact indication copy from the source website.</p>
            </div>
          </div>
          <div className="rounded-xl border border-emerald-200 bg-white p-4 max-h-[420px] overflow-auto">
            <pre className="text-sm text-zinc-800 leading-6 whitespace-pre-wrap font-sans">{data.indication}</pre>
            {data.indication_source_url && (
              <a href={data.indication_source_url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-emerald-800 hover:text-emerald-900">
                Source URL
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
          </div>
        </section>
      ) : null}

      {data.important_safety_information ? (
        <section className="rounded-2xl border-2 border-amber-300 bg-amber-50 p-6 shadow-sm">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center">
              <ShieldAlert className="w-5 h-5 text-amber-700" />
            </div>
            <div>
              <h4 className="text-lg font-semibold text-amber-950">Important Safety Information</h4>
              <p className="text-sm text-amber-800">Exact ISI content preserved from the source website.</p>
            </div>
          </div>
          <div className="rounded-xl border border-amber-200 bg-white p-4 max-h-[420px] overflow-auto">
            <pre className="text-sm text-zinc-800 leading-6 whitespace-pre-wrap font-sans">{data.important_safety_information}</pre>
            {data.important_safety_information_source_url && (
              <a href={data.important_safety_information_source_url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-amber-800 hover:text-amber-900">
                Source URL
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function BriefImage({
  asset,
  resolveImageSrc,
}: {
  asset?: Asset | null;
  resolveImageSrc: (asset?: Asset | null) => string;
}) {
  const remote = String(asset?.remote_url || asset?.url || '').trim();
  const src = resolveImageSrc(asset);
  const [failed, setFailed] = useState(false);

  if (!remote) return null;

  if (!src || failed) {
    return (
      <div className="aspect-video bg-zinc-100 border-b border-zinc-200 p-4 flex flex-col justify-center">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Image path</p>
        <a href={remote} target="_blank" rel="noopener noreferrer" className="mt-2 text-sm text-blue-700 break-all hover:underline">
          {remote}
        </a>
      </div>
    );
  }

  return (
    <div className="aspect-video bg-zinc-100">
      <img
        src={src}
        alt={asset?.alt || asset?.title || ''}
        className="h-full w-full object-cover"
        loading="lazy"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

function BriefHeroMedia({
  heroVideo,
  heroImage,
  resolveImageSrc,
}: {
  heroVideo?: Asset | null;
  heroImage?: Asset | null;
  resolveImageSrc: (asset?: Asset | null) => string;
}) {
  const videoUrl = String(heroVideo?.url || '').trim();
  const imageSrc = resolveImageSrc(heroImage);
  const poster = resolveImageSrc({ ...heroImage, url: heroVideo?.poster || heroImage?.url || '' }) || imageSrc;

  if (videoUrl && !isEmbeddableVideoUrl(videoUrl)) {
    return (
      <video
        className="absolute inset-0 h-full w-full object-cover"
        src={videoUrl}
        poster={poster || undefined}
        controls
        playsInline
        preload="metadata"
      />
    );
  }

  if (videoUrl && isEmbeddableVideoUrl(videoUrl)) {
    return (
      <a href={videoUrl} target="_blank" rel="noopener noreferrer" className="absolute inset-0 block">
        {poster ? (
          <img src={poster} alt="" className="absolute inset-0 h-full w-full object-cover" loading="lazy" />
        ) : (
          <div className="absolute inset-0 bg-zinc-800" />
        )}
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg">
            <Play className="w-7 h-7 fill-current" />
          </span>
        </span>
      </a>
    );
  }

  if (imageSrc) {
    return <img src={imageSrc} alt="" className="absolute inset-0 h-full w-full object-cover" loading="lazy" />;
  }

  const remote = String(heroImage?.remote_url || heroImage?.url || '').trim();
  if (remote) {
    return (
      <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Hero image path</p>
          <a href={remote} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-sm text-blue-300 break-all hover:underline">
            {remote}
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 flex items-center justify-center text-zinc-400 text-sm">
      No hero media detected
    </div>
  );
}

function BriefVideoGallery({
  assets,
  resolveImageSrc,
}: {
  assets: Asset[];
  resolveImageSrc: (asset?: Asset | null) => string;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4 border-b border-zinc-100">
      {assets.slice(0, 4).map((asset) => {
        const videoUrl = String(asset.url || '').trim();
        const poster = resolveImageSrc({ ...asset, url: asset.poster || asset.url });
        return (
          <a
            key={videoUrl}
            href={videoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="relative aspect-video overflow-hidden rounded-lg bg-zinc-900"
          >
            {poster ? (
              <img src={poster} alt="" className="absolute inset-0 h-full w-full object-cover opacity-80" loading="lazy" />
            ) : null}
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg">
                <Play className="w-5 h-5 fill-current" />
              </span>
            </span>
          </a>
        );
      })}
    </div>
  );
}

function buildBriefTabSlidesClient(
  cards: Array<{ title?: string; text?: string; quote?: string }>,
  images: Asset[],
  videos: Asset[],
  preferVideoGallery: boolean
): BriefSlide[] {
  const slides: BriefSlide[] = [];
  for (let i = 0; i < 3; i += 1) {
    const card = cards[i];
    const slideImage = images[i] || images[0] || null;
    if (!card && !slideImage) continue;
    const slideHeading = card?.title || (card?.text ? card.text.slice(0, 90) : card?.quote ? card.quote.slice(0, 90) : '');
    const slideBody = card?.text || card?.quote || '';
    if (!slideHeading && !slideBody && !slideImage) continue;
    const slideVideos = videos.slice(i * 2, i * 2 + 3);
    const useGallery = preferVideoGallery && slideVideos.length > 0;
    slides.push({
      layout: useGallery ? 'video-gallery' : 'image-text',
      heading: slideHeading || 'Supporting message',
      body: slideBody,
      cta: 'Learn more',
      image: useGallery ? null : slideImage,
      media_assets: useGallery ? slideVideos : [],
    });
  }
  return slides;
}

function buildBriefTabsFromInsights(data: CreativeInsights, imageLookup: Map<string, string>): BriefTab[] {
  const withPreview = (asset: Asset | null | undefined): Asset | null => {
    if (!asset?.url) return null;
    const cached = imageLookup.get(asset.url);
    return { ...asset, remote_url: asset.url, preview_url: cached };
  };

  const videos = [...(data.hero_videos || []), ...(data.videos || [])];
  const images = [...(data.hero_images || []), ...(data.gallery_assets || [])];
  const focusCards = data.main_focus_cards?.length
    ? data.main_focus_cards
    : data.main_focus
      ? [{ text: data.main_focus }]
      : [];
  const featureCards = data.feature_cards?.length
    ? data.feature_cards
    : data.features.map((feature) => ({ text: feature }));

  return [
    {
      id: 1,
      label: 'Tab 1',
      layout: 'hero-video',
      heading: data.heading || 'Campaign heading',
      subheading: (focusCards[0]?.text || '').slice(0, 220) || undefined,
      cta: 'Learn more',
      hero_video: withPreview(videos[0] || null),
      hero_image: withPreview(images[0] || null),
      slides: [],
    },
    {
      id: 2,
      label: 'Tab 2',
      layout: 'slides',
      slides: buildBriefTabSlidesClient(featureCards.slice(0, 3), images, videos, videos.length > 0).map((slide) => ({
        ...slide,
        image: slide.image ? withPreview(slide.image) : null,
        media_assets: (slide.media_assets || []).map((asset) => withPreview(asset)!).filter(Boolean),
      })),
    },
    {
      id: 3,
      label: 'Tab 3',
      layout: 'slides',
      slides: buildBriefTabSlidesClient(
        featureCards.slice(3, 6).length ? featureCards.slice(3, 6) : (data.testimonial_cards || []).slice(0, 3),
        images.slice(3),
        videos.slice(3),
        videos.length > 2
      ).map((slide) => ({
        ...slide,
        image: slide.image ? withPreview(slide.image) : null,
        media_assets: (slide.media_assets || []).map((asset) => withPreview(asset)!).filter(Boolean),
      })),
    },
  ];
}

function buildFallbackInsights(url: string, fallbackAssets?: { images?: any[]; videos?: any[] } | null): CreativeInsights | null {
  if (!fallbackAssets) return null;
  const images = Array.isArray(fallbackAssets.images) ? fallbackAssets.images : [];
  const videos = Array.isArray(fallbackAssets.videos) ? fallbackAssets.videos : [];
  if (!images.length && !videos.length) return null;

  const host = (() => {
    try { return new URL(url).hostname; } catch { return url || 'Website'; }
  })();

  const heroImages = images.slice(0, 6).map((item: any) => ({
    url: item.url,
    preview_url: item.cachedUrl,
    remote_url: item.url,
    title: item.title || '',
  }));
  const heroVideos = videos.slice(0, 4).map((item: any) => ({
    url: item.url,
    title: item.title || 'Video',
    poster: item.thumbnail || item.poster || '',
  }));

  const imageLookup = new Map<string, string>();
  for (const img of images) {
    if (img?.url && img?.cachedUrl) imageLookup.set(img.url, img.cachedUrl);
  }

  return {
    ...emptyInsights,
    heading: host,
    hero_images: heroImages,
    hero_videos: heroVideos,
    gallery_assets: heroImages,
    videos: heroVideos,
    brief_tabs: buildBriefTabsFromInsights(
      {
        ...emptyInsights,
        heading: host,
        hero_images: heroImages,
        hero_videos: heroVideos,
        gallery_assets: heroImages,
        videos: heroVideos,
        main_focus: '',
        features: [],
        testimonials: [],
      },
      imageLookup
    ),
  };
}
