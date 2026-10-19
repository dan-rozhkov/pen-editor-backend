// Data for the showcase's dealt art direction (direction.ts): type systems and
// palettes distilled by tasteskill v2 from a study of 247 gallery sites.
// Source: github.com/Leonxlnx/taste-skill @ b9ca2fd, skills/taste-skill/library/
// {type,palettes}.json. MIT License, Copyright (c) 2026 Leonxlnx.
// Only type systems whose faces are both on Google Fonts are kept: the
// prototype skill loads fonts with @import from fonts.googleapis.com and
// nothing else. Regenerate rather than hand-edit.

export interface DirectionFace {
  family: string;
  weights: number[];
  settings: string;
}

export interface TypeSystem {
  id: string;
  name: string;
  class: string;
  display: DirectionFace;
  text: DirectionFace;
  note: string;
}

export interface DirectionPalette {
  id: string;
  name: string;
  bg: string;
  surface: string;
  ink: string;
  muted: string;
  accent: string;
  accentInk: string;
  fields: Array<{ bg: string; ink: string }>;
  note: string;
}

export const TYPE_SYSTEMS: TypeSystem[] = [
  {
    "id": "schibsted-heavy",
    "name": "Schibsted Grotesk",
    "class": "grotesk-tight",
    "display": {
      "family": "Schibsted Grotesk",
      "weights": [
        800
      ],
      "settings": "weight 800 · tracking -0.05em · leading 0.88 · sentence case or all lowercase"
    },
    "text": {
      "family": "Schibsted Grotesk",
      "weights": [
        400,
        600
      ],
      "settings": "400 for paragraphs, 600 for navigation and other functional text · leading 1.4 · tracking -0.01em"
    },
    "note": "A compact, warm grotesk set heavy with letters almost touching; small text stays in the same family at semibold. Suits music, events and culture pages where the type is the image."
  },
  {
    "id": "hanken-medium",
    "name": "Hanken Grotesk",
    "class": "grotesk-tight",
    "display": {
      "family": "Hanken Grotesk",
      "weights": [
        500
      ],
      "settings": "weight 500 · tracking -0.05em · leading 0.9 · sentence case; one statement size (about 6vw) used for every heading"
    },
    "text": {
      "family": "Hanken Grotesk",
      "weights": [
        400,
        500
      ],
      "settings": "400 for body, 500 for emphasis · leading 1.45 · tracking -0.005em"
    },
    "note": "Medium-weight grotesk statements at one large size against caption-size text: a two-size system with no bold. Suits portfolios, agencies and tools that speak in short declarative lines."
  },
  {
    "id": "bricolage-contrast",
    "name": "Bricolage Grotesque",
    "class": "grotesk-tight",
    "display": {
      "family": "Bricolage Grotesque",
      "weights": [
        600
      ],
      "settings": "weight 600 · tracking -0.04em · leading 0.92 · sentence case; leave optical sizing on so large sizes tighten and gain contrast"
    },
    "text": {
      "family": "Bricolage Grotesque",
      "weights": [
        400,
        500
      ],
      "settings": "400 for body, 500 for emphasis · leading 1.5 · tracking 0"
    },
    "note": "A grotesk with visible stroke contrast and slightly irregular curves, so headings look drawn rather than engineered. Suits reports, consultancies and design-led software that want warmth without a serif."
  },
  {
    "id": "franklin-source",
    "name": "Libre Franklin / Source Serif 4",
    "class": "grotesk-tight",
    "display": {
      "family": "Libre Franklin",
      "weights": [
        700
      ],
      "settings": "weight 700 · tracking -0.035em · leading 0.92 · uppercase for the title, sentence case for section headings"
    },
    "text": {
      "family": "Source Serif 4",
      "weights": [
        400,
        600
      ],
      "settings": "400 for body, 600 for emphasis, italic for quotations · leading 1.55 · tracking 0"
    },
    "note": "An American gothic for headings over a sober transitional serif for reading, the pairing of a newspaper front page. Suits essays, annual reports, archives and finance pages that have real paragraphs."
  },
  {
    "id": "archivo-regular",
    "name": "Archivo",
    "class": "grotesk-light",
    "display": {
      "family": "Archivo",
      "weights": [
        400
      ],
      "settings": "weight 400 · tracking -0.02em · leading 1.0 · sentence case; never bold, inactive items fade to grey"
    },
    "text": {
      "family": "Archivo",
      "weights": [
        400,
        600
      ],
      "settings": "400 for body, 600 for buttons and short emphasis · leading 1.5 · tracking 0"
    },
    "note": "A sturdy grotesque kept at regular weight even at 88px, so the page reads as composed rather than loud. Suits finance, infrastructure and research pages that need to look sober and current."
  },
  {
    "id": "work-sans-light",
    "name": "Work Sans",
    "class": "grotesk-light",
    "display": {
      "family": "Work Sans",
      "weights": [
        300
      ],
      "settings": "weight 300 · tracking -0.035em · leading 1.0 · sentence case"
    },
    "text": {
      "family": "Work Sans",
      "weights": [
        400,
        500
      ],
      "settings": "400 for body, 500 for emphasis · leading 1.55 · tracking 0"
    },
    "note": "A light grotesque with open, slightly old-fashioned shapes; large headings look airy and the text weight beneath stays easy to read. Suits AI and research products, fashion houses and calm brand sites."
  },
  {
    "id": "anton-work",
    "name": "Anton / Work Sans",
    "class": "condensed-heavy",
    "display": {
      "family": "Anton",
      "weights": [
        400
      ],
      "settings": "weight 400 (single heavy cut) · tracking -0.01em · leading 0.86 · uppercase"
    },
    "text": {
      "family": "Work Sans",
      "weights": [
        400,
        600
      ],
      "settings": "400 for body, 600 for links and short emphasis · leading 1.5 · tracking 0"
    },
    "note": "Compressed heavy capitals stacked tight, with a neutral grotesque kept small beneath. Suits fashion drops, sport, nightlife and any page built as a poster."
  },
  {
    "id": "big-shoulders-public",
    "name": "Big Shoulders / Public Sans",
    "class": "condensed-heavy",
    "display": {
      "family": "Big Shoulders",
      "weights": [
        800
      ],
      "settings": "weight 800 · tracking -0.005em · leading 0.88 · uppercase"
    },
    "text": {
      "family": "Public Sans",
      "weights": [
        400,
        600
      ],
      "settings": "400 for body, 600 for emphasis · leading 1.5 · tracking 0"
    },
    "note": "A tall American gothic taken from city signage, blunt and civic, over a plain public-service sans. Suits culture indexes, community projects, bars, sport clubs and local campaigns."
  },
  {
    "id": "archivo-compressed",
    "name": "Archivo",
    "class": "condensed-heavy",
    "display": {
      "family": "Archivo",
      "weights": [
        800
      ],
      "settings": "weight 800 at font-stretch 62% (load the wdth axis and use its narrowest setting) · tracking -0.01em · leading 0.86 · uppercase"
    },
    "text": {
      "family": "Archivo",
      "weights": [
        400,
        500
      ],
      "settings": "normal width · 400 for body, 500 for buttons and emphasis · leading 1.5 · tracking 0"
    },
    "note": "One variable family pushed to its narrowest, heaviest setting for headlines and relaxed to normal width for text, so display and body share a skeleton. Suits sportswear, campaigns and fintech pages that speak in capitals."
  },
  {
    "id": "bebas-garamond",
    "name": "Bebas Neue / EB Garamond",
    "class": "condensed-heavy",
    "display": {
      "family": "Bebas Neue",
      "weights": [
        400
      ],
      "settings": "weight 400 (single cut, capitals only) · tracking -0.02em, tightening to -0.06em above 15vw · leading 0.85 · uppercase"
    },
    "text": {
      "family": "EB Garamond",
      "weights": [
        400,
        500
      ],
      "settings": "leading 1.45 · tracking 0"
    },
    "note": "Huge condensed capitals against a light old-style serif with italics: an industrial voice and a literary one, with a twenty-fold size gap between them. Suits crafted physical products, spirits, outdoor goods and hospitality."
  },
  {
    "id": "barlow-condensed",
    "name": "Barlow Condensed / Barlow",
    "class": "condensed-heavy",
    "display": {
      "family": "Barlow Condensed",
      "weights": [
        700
      ],
      "settings": "weight 700 · tracking -0.02em · leading 0.9 · uppercase for statements, mixed case for item titles"
    },
    "text": {
      "family": "Barlow",
      "weights": [
        400,
        500
      ],
      "settings": "400 for body, 500 for emphasis · leading 1.5 · tracking 0"
    },
    "note": "Road-sign condensed type with squared curves, bold but not compressed into a wall, with its normal-width sibling for text. Suits logistics, motorsport, hardware and directories with many short titles."
  },
  {
    "id": "tiktok-sans-wide",
    "name": "TikTok Sans",
    "class": "extended-heavy",
    "display": {
      "family": "TikTok Sans",
      "weights": [
        800
      ],
      "settings": "weight 800 at font-stretch 150% (load the wdth axis and use its widest setting) · tracking -0.01em · leading 1.0 · uppercase"
    },
    "text": {
      "family": "TikTok Sans",
      "weights": [
        400,
        500
      ],
      "settings": "normal width · 400 for body, 500 for emphasis · leading 1.45 · tracking 0"
    },
    "note": "One variable grotesk stretched wide and bold for the headline and the closing statement, then returned to normal width for reading. Suits personal portfolios, apps and tech brands that want width without a second family."
  },
  {
    "id": "unbounded-onest",
    "name": "Unbounded / Onest",
    "class": "extended-heavy",
    "display": {
      "family": "Unbounded",
      "weights": [
        800
      ],
      "settings": "weight 800 · tracking -0.03em · leading 1.0 · uppercase"
    },
    "text": {
      "family": "Onest",
      "weights": [
        400,
        500
      ],
      "settings": "400 for body, 500 for emphasis · leading 1.5 · tracking 0"
    },
    "note": "A wide display sans built from rounded squares, heavy and a little architectural, beside a clean text grotesk. Suits architecture indexes, watches, mobility and events that want a title with a constructed feel."
  },
  {
    "id": "chivo-black",
    "name": "Chivo",
    "class": "heavy-black",
    "display": {
      "family": "Chivo",
      "weights": [
        900
      ],
      "settings": "weight 900 · tracking -0.05em · leading 0.88 · uppercase"
    },
    "text": {
      "family": "Chivo",
      "weights": [
        400,
        700
      ],
      "settings": "400 for paragraphs, 700 for navigation, tags and links · leading 1.35 · tracking -0.01em"
    },
    "note": "A black grotesque in capitals with letters nearly colliding, and only two sizes on the page: enormous and small. Suits agencies, city and culture projects and musicians who want the type to land like a headline."
  },
  {
    "id": "epilogue-black",
    "name": "Epilogue",
    "class": "heavy-black",
    "display": {
      "family": "Epilogue",
      "weights": [
        900
      ],
      "settings": "weight 900 · tracking -0.04em · leading 0.9 · sentence case or title case"
    },
    "text": {
      "family": "Epilogue",
      "weights": [
        400,
        500
      ],
      "settings": "400 for body, 500 for emphasis · leading 1.5 · tracking 0"
    },
    "note": "A broad black grotesque with a slightly uneven rhythm, at its best as a name set very large in mixed case. Suits entertainers, podcasts, consumer apps and blunt SaaS pages; emphasis comes from colour, not from a change of weight."
  },
  {
    "id": "red-hat-black",
    "name": "Red Hat Display / Red Hat Text",
    "class": "heavy-black",
    "display": {
      "family": "Red Hat Display",
      "weights": [
        900
      ],
      "settings": "weight 900 · tracking -0.03em · leading 0.92 · uppercase; centred three-line stacks work well"
    },
    "text": {
      "family": "Red Hat Text",
      "weights": [
        400,
        500
      ],
      "settings": "400 for body, 500 for emphasis · leading 1.5 · tracking 0"
    },
    "note": "A geometric black with round bowls and flat terminals, cleaner and more even than a grotesque at the same weight. Suits fintech, apps and portfolios that want heavy type with a tidy, technical finish."
  },
  {
    "id": "jost-caps",
    "name": "Jost",
    "class": "geometric",
    "display": {
      "family": "Jost",
      "weights": [
        700
      ],
      "settings": "weight 700 · tracking -0.03em · leading 0.9 · uppercase"
    },
    "text": {
      "family": "Jost",
      "weights": [
        400,
        500
      ],
      "settings": "400 for body, 500 for emphasis · leading 1.5 · tracking 0"
    },
    "note": "The pointed, circular geometry of the 1920s in bold capitals, with the same family at reading size. Suits space, science, museums, architecture and anything that should feel like a mid-century poster."
  },
  {
    "id": "stack-sans-light",
    "name": "Stack Sans Headline / Stack Sans Text",
    "class": "geometric",
    "display": {
      "family": "Stack Sans Headline",
      "weights": [
        300
      ],
      "settings": "weight 300 · tracking -0.022em · leading 1.05 · sentence case; a heading may be two-tone, grey then full ink"
    },
    "text": {
      "family": "Stack Sans Text",
      "weights": [
        400,
        500
      ],
      "settings": "400 for body, 500 for emphasis · leading 1.5 · tracking 0"
    },
    "note": "A geometric sans in a light weight at large size, soft and exact at once, with its text cut underneath. Suits consumer apps, utilities and developer tools that want to feel calm and modern."
  },
  {
    "id": "albert-sans-semibold",
    "name": "Albert Sans",
    "class": "geometric",
    "display": {
      "family": "Albert Sans",
      "weights": [
        600
      ],
      "settings": "weight 600 · tracking -0.035em · leading 1.0 · sentence case"
    },
    "text": {
      "family": "Albert Sans",
      "weights": [
        400,
        500
      ],
      "settings": "400 for body, 500 for emphasis · leading 1.5 · tracking 0"
    },
    "note": "A geometric grotesque with Scandinavian restraint: round letters, even colour, nothing decorative. Suits logistics, health, property and corporate sites that need to look clear and dependable."
  },
  {
    "id": "spartan-figtree",
    "name": "League Spartan / Figtree",
    "class": "geometric",
    "display": {
      "family": "League Spartan",
      "weights": [
        700
      ],
      "settings": "weight 700 · tracking -0.04em · leading 0.88 · lowercase or sentence case"
    },
    "text": {
      "family": "Figtree",
      "weights": [
        400,
        600
      ],
      "settings": "400 for body, 600 for emphasis · leading 1.5 · tracking 0"
    },
    "note": "A compact bold geometric with a low waist, punchy in short lowercase lines, over a friendly open text sans. Suits newsletters, consumer products, creators and small shops."
  },
  {
    "id": "bodoni-jost",
    "name": "Bodoni Moda / Jost",
    "class": "serif-display",
    "display": {
      "family": "Bodoni Moda",
      "weights": [
        500
      ],
      "settings": "weight 500 with optical sizing on · tracking -0.02em · leading 0.95 · uppercase or sentence case; italic for a whole line, never for one word"
    },
    "text": {
      "family": "Jost",
      "weights": [
        400,
        500
      ],
      "settings": "400 for body, 500 for emphasis · leading 1.6 · tracking 0.01em"
    },
    "note": "A true didone with hairline serifs and vertical stress over a light geometric sans, the classic fashion-magazine pairing. Suits luxury property, jewellery, fragrance and fashion."
  },
  {
    "id": "imbue-albert",
    "name": "Imbue / Albert Sans",
    "class": "serif-display",
    "display": {
      "family": "Imbue",
      "weights": [
        400
      ],
      "settings": "weight 400 with optical sizing on · tracking -0.01em · leading 0.9 · uppercase, sized so one short word fills its column (6–12vw)"
    },
    "text": {
      "family": "Albert Sans",
      "weights": [
        400,
        500
      ],
      "settings": "400 for body, 500 for emphasis · leading 1.55 · tracking 0"
    },
    "note": "A tall, condensed high-contrast serif whose capitals read like a masthead or a shop fascia. Suits residences, hotels, restaurants and wine, where a short name can stand floor to ceiling."
  },
  {
    "id": "newsreader-light",
    "name": "Newsreader",
    "class": "serif-light-large",
    "display": {
      "family": "Newsreader",
      "weights": [
        300
      ],
      "settings": "weight 300 with optical sizing on · tracking -0.05em · leading 0.9 · sentence case at 12–14vw; chapter headings drop to the text weight at about 30px"
    },
    "text": {
      "family": "Newsreader",
      "weights": [
        400,
        500
      ],
      "settings": "400 for body, 500 for emphasis, italic for titles · leading 1.6 · tracking 0"
    },
    "note": "One news serif with optical sizes: light and very tight when huge, open and bookish at 18px. Suits long-form stories, culture pieces, journals and research write-ups."
  },
  {
    "id": "eb-garamond-quiet",
    "name": "EB Garamond",
    "class": "serif-text",
    "display": {
      "family": "EB Garamond",
      "weights": [
        400
      ],
      "settings": "weight 400, italic for the title · tracking -0.01em · leading 1.1 · sentence case or all lowercase; the largest size stays near 40px"
    },
    "text": {
      "family": "EB Garamond",
      "weights": [
        400,
        500
      ],
      "settings": "400 for body, 500 for emphasis · leading 1.5 · tracking 0"
    },
    "note": "A humanist Garamond in roman and italic at two modest sizes, with no capitals and no bold. Suits set designers, antique dealers, wine, publishers and portfolios that whisper."
  },
  {
    "id": "literata-book",
    "name": "Literata",
    "class": "serif-text",
    "display": {
      "family": "Literata",
      "weights": [
        500
      ],
      "settings": "weight 500 with optical sizing on · tracking -0.02em · leading 1.05 · sentence case"
    },
    "text": {
      "family": "Literata",
      "weights": [
        400,
        600
      ],
      "settings": "400 for body, 600 for emphasis, italic for titles · leading 1.6 · tracking 0"
    },
    "note": "A sturdy screen-reading serif with a large x-height; headings are simply the text face at medium weight and a larger size. Suits essays, reports, newsletters and knowledge products."
  },
  {
    "id": "stix-plain-roman",
    "name": "STIX Two Text",
    "class": "serif-text",
    "display": {
      "family": "STIX Two Text",
      "weights": [
        400
      ],
      "settings": "weight 400 · tracking -0.026em · leading 1.1 · sentence case at 2.6–3.6vw; one running line may be set in italic capitals"
    },
    "text": {
      "family": "STIX Two Text",
      "weights": [
        400,
        600
      ],
      "settings": "400 for body, 600 for emphasis · leading 1.45 · tracking 0"
    },
    "note": "The plain Times-style roman of a typed document, slightly tightened and never larger than a few vw. Suits vehicles and tools presented dryly, artists' pages, investment memos and anything meant to look undesigned on purpose."
  },
  {
    "id": "young-source",
    "name": "Young Serif / Source Serif 4",
    "class": "serif-text",
    "display": {
      "family": "Young Serif",
      "weights": [
        400
      ],
      "settings": "weight 400 (single heavy cut) · tracking -0.02em · leading 0.95 · sentence case"
    },
    "text": {
      "family": "Source Serif 4",
      "weights": [
        400,
        600
      ],
      "settings": "400 for body, 600 for emphasis, italic for quotations · leading 1.55 · tracking 0"
    },
    "note": "A heavy, round old-style headline face with soft bracketed serifs over a clear transitional text serif. Suits essays, food, independent publishers and personal sites that want warmth with weight."
  },
  {
    "id": "zilla-slab-even",
    "name": "Zilla Slab",
    "class": "slab",
    "display": {
      "family": "Zilla Slab",
      "weights": [
        600
      ],
      "settings": "weight 600 · tracking -0.025em · leading 1.0 · sentence case"
    },
    "text": {
      "family": "Zilla Slab",
      "weights": [
        400,
        500
      ],
      "settings": "400 for body, 500 for emphasis · leading 1.5 · tracking 0"
    },
    "note": "A contemporary slab with smooth curves and unbracketed serifs, even enough to carry headings and paragraphs alike. Suits developer tools, personal sites, open-source and nonprofit projects."
  },
  {
    "id": "besley-franklin",
    "name": "Besley / Libre Franklin",
    "class": "slab",
    "display": {
      "family": "Besley",
      "weights": [
        800
      ],
      "settings": "weight 800 · tracking -0.02em · leading 0.95 · sentence case or uppercase"
    },
    "text": {
      "family": "Libre Franklin",
      "weights": [
        400,
        600
      ],
      "settings": "400 for body, 600 for emphasis · leading 1.5 · tracking 0"
    },
    "note": "A fat Clarendon with ball terminals and bracketed slabs over a plain gothic, the look of a nineteenth-century bill poster. Suits breweries, barbers, markets, fairs and heritage goods."
  },
  {
    "id": "rokkitt-literata",
    "name": "Rokkitt / Literata",
    "class": "slab",
    "display": {
      "family": "Rokkitt",
      "weights": [
        800
      ],
      "settings": "weight 800 · tracking -0.01em · leading 0.85 · uppercase, sized by cap height (about 14vw)"
    },
    "text": {
      "family": "Literata",
      "weights": [
        400,
        600
      ],
      "settings": "400 for body, 600 for emphasis · leading 1.6 · tracking 0"
    },
    "note": "Narrow geometric slab capitals as a tall title block, then a bookish serif for a long essay beneath. Suits manufacturing, trades, manifestos and industrial history."
  }
];

export const PALETTES: DirectionPalette[] = [
  {
    "id": "white-link-blue",
    "name": "Sheet and biro",
    "bg": "#ffffff",
    "surface": "#f4f4f4",
    "ink": "#111111",
    "muted": "#6b6b6b",
    "accent": "#1a4be0",
    "accentInk": "#ffffff",
    "note": "White holds the whole page with black type, one grey for secondary lines and a pale grey step for tiles and inputs; the footer may invert to black. Blue is the colour of text links and the one button, and nothing else is tinted.",
    "fields": [
      {
        "bg": "#111111",
        "ink": "#ffffff"
      }
    ]
  },
  {
    "id": "cool-white-slate",
    "name": "Frost and slate",
    "bg": "#f7f9fa",
    "surface": "#ecf0f2",
    "ink": "#1f3038",
    "muted": "#5d6b72",
    "accent": "#0d7480",
    "accentInk": "#ffffff",
    "note": "Cool white and one paler blue-grey step hold everything, with type in dark slate instead of black. Teal appears once per screen at most, as the primary button or one small detail beside the product photograph.",
    "fields": []
  },
  {
    "id": "rose-grey-green",
    "name": "Rose grey, green",
    "bg": "#ebe5e3",
    "surface": "#e1dad7",
    "ink": "#2b2622",
    "muted": "#6a615d",
    "accent": "#0f7d45",
    "accentInk": "#ffffff",
    "note": "A single rosy grey covers the page from top to bottom with brown-black text and grey secondary lines; images are kept greyscale. Green appears only on the current-page link and on one button in the footer.",
    "fields": []
  },
  {
    "id": "paper-grey-brass",
    "name": "Newsprint and brass",
    "bg": "#e8e8e3",
    "surface": "#dcdcd6",
    "ink": "#181715",
    "muted": "#63625c",
    "accent": "#bfb21a",
    "accentInk": "#181715",
    "note": "Warm paper grey with near-black type holds the upper page, then whole sections flip to near-black with paper-grey type; no section is tinted. Brass yellow marks one small detail per screen, such as the button or a single word.",
    "fields": [
      {
        "bg": "#181715",
        "ink": "#e8e8e3"
      }
    ]
  },
  {
    "id": "stone-blueprint",
    "name": "Stone and blueprint",
    "bg": "#dfdedb",
    "surface": "#d3d2ce",
    "ink": "#26251e",
    "muted": "#5f5d55",
    "accent": "#2456d6",
    "accentInk": "#ffffff",
    "note": "Stone paper carries the whole page with near-black and grey text. One image at a time is printed in the accent blue as its only ink, and the same blue fills the single button.",
    "fields": []
  },
  {
    "id": "white-navy-tab",
    "name": "Navy on white",
    "bg": "#ffffff",
    "surface": "#f4f4f2",
    "ink": "#1f2b4d",
    "muted": "#6a7186",
    "accent": "#f7941d",
    "accentInk": "#1f2b4d",
    "note": "Pure white pages with navy type sit between full-bleed photographs, opening on near-black and closing on a warm grey footer. Tangerine is one small tab or button, never larger than a thumbnail.",
    "fields": [
      {
        "bg": "#05070a",
        "ink": "#ffffff"
      },
      {
        "bg": "#e3e1dc",
        "ink": "#1f2b4d"
      }
    ]
  },
  {
    "id": "three-stones",
    "name": "Three stones",
    "bg": "#eeecea",
    "surface": "#e4e1dd",
    "ink": "#333231",
    "muted": "#6b6763",
    "accent": "#5c6b54",
    "accentInk": "#ffffff",
    "note": "Three close stone tones share the interface: the lightest for the page, the middle one for panels, the darkest for a single band, all with charcoal type. Saturated colour is left to the photographs and their backdrops; the grey-green fills the button only.",
    "fields": [
      {
        "bg": "#cdc3b6",
        "ink": "#333231"
      }
    ]
  },
  {
    "id": "putty-black-teal",
    "name": "Putty and black",
    "bg": "#dedad3",
    "surface": "#d3cec6",
    "ink": "#0a0a0a",
    "muted": "#5c5852",
    "accent": "#256f82",
    "accentInk": "#ffffff",
    "note": "Warm putty covers the page and pure black handles all type and the main shapes. The only tint in the interface is teal, used for the one button or a single marker placed near the photographs.",
    "fields": []
  },
  {
    "id": "moss-sand",
    "name": "Sand and moss",
    "bg": "#ddd6c6",
    "surface": "#d2cab8",
    "ink": "#2a2a26",
    "muted": "#59574e",
    "accent": "#4f6238",
    "accentInk": "#ffffff",
    "note": "Sand grey holds the page with charcoal type, and one deep leaf-green band may close it. Moss green is reserved for buttons; brighter greens and blues arrive only through photographs.",
    "fields": [
      {
        "bg": "#3f5a2a",
        "ink": "#ffffff"
      }
    ]
  },
  {
    "id": "green-mat-chocolate",
    "name": "Bone, green, chocolate",
    "bg": "#e5e1d8",
    "surface": "#dad5ca",
    "ink": "#2a1d17",
    "muted": "#6b5b51",
    "accent": "#456f3a",
    "accentInk": "#ffffff",
    "note": "Bone ground with chocolate-brown text takes most of the page. The green is spent on one large flat block, about a third of a screen, and on the button; all other colour comes from photographs.",
    "fields": [
      {
        "bg": "#456f3a",
        "ink": "#ffffff"
      }
    ]
  },
  {
    "id": "lunar-grey-bronze",
    "name": "Lunar and bronze",
    "bg": "#111111",
    "surface": "#1c1c1c",
    "ink": "#f2f2f2",
    "muted": "#8f8f8f",
    "accent": "#a08672",
    "accentInk": "#111111",
    "note": "Soft black holds the page with panels one step lighter, white text and grey secondary lines, so photographs supply all the colour. Muted bronze goes on small markers and the one button only.",
    "fields": []
  },
  {
    "id": "blue-black-cornflower",
    "name": "Night and cornflower",
    "bg": "#0a0d14",
    "surface": "#131824",
    "ink": "#e9edf3",
    "muted": "#8891a1",
    "accent": "#5a9bfc",
    "accentInk": "#0a0d14",
    "note": "Blue-black ground and slate panels with silver-white text fill the page; no section changes colour. Cornflower blue marks the buttons and at most one word in a heading.",
    "fields": []
  },
  {
    "id": "green-black-bone",
    "name": "Green-black and bone",
    "bg": "#161c1a",
    "surface": "#1f2725",
    "ink": "#e3e2da",
    "muted": "#8e948d",
    "accent": "#9fc7b8",
    "accentInk": "#161c1a",
    "note": "Bone type on green-black from top to bottom, with panels and drawn details barely lighter than the ground so photographs supply the colour. Pale jade is for the booking or contact button alone.",
    "fields": []
  },
  {
    "id": "black-crimson",
    "name": "Black and crimson",
    "bg": "#0a0a0a",
    "surface": "#151515",
    "ink": "#efefef",
    "muted": "#8c8c8c",
    "accent": "#b11226",
    "accentInk": "#ffffff",
    "note": "Black with off-white text and mid-grey texture takes nearly the whole page, and the last sections may invert to off-white with black type. Deep crimson is scattered sparingly: a few characters in a heading, a slider fill, the one button.",
    "fields": [
      {
        "bg": "#efefef",
        "ink": "#0a0a0a"
      }
    ]
  },
  {
    "id": "forest-pale-lime",
    "name": "Forest and lime",
    "bg": "#0f1f10",
    "surface": "#162a17",
    "ink": "#ffffff",
    "muted": "#9aa39a",
    "accent": "#c6f19d",
    "accentInk": "#0f1f10",
    "note": "Forest green, black and white sections alternate, with forest green holding the most; photographs stay in moss greens and stone browns. Pale lime sits on small squares only, such as arrow buttons and the closing wordmark.",
    "fields": [
      {
        "bg": "#000000",
        "ink": "#ffffff"
      },
      {
        "bg": "#ffffff",
        "ink": "#0f1f10"
      }
    ]
  },
  {
    "id": "charcoal-room-sage",
    "name": "Charcoal and sage",
    "bg": "#1c1c1c",
    "surface": "#262626",
    "ink": "#f1f1ef",
    "muted": "#9a9b96",
    "accent": "#8fa68e",
    "accentInk": "#1c1c1c",
    "note": "Charcoal holds the page with off-white text, and one section may flip to a pale concrete tone with dark text. Colour comes from the photographs; grey sage is used for the single button and the active state of a control.",
    "fields": [
      {
        "bg": "#c8c5ba",
        "ink": "#1c1c1c"
      }
    ]
  },
  {
    "id": "warm-black-gold",
    "name": "Warm black, gold",
    "bg": "#0c0a08",
    "surface": "#181512",
    "ink": "#ffffff",
    "muted": "#8f8a84",
    "accent": "#c9a45a",
    "accentInk": "#0c0a08",
    "note": "Warm near-black fills the page and photographs sit bright against it, with pure white small type; panels warm to a brown-black. Gold is for one text link or small button per screen, never a field.",
    "fields": []
  },
  {
    "id": "graphite-safety-orange",
    "name": "Graphite and orange",
    "bg": "#18191b",
    "surface": "#222427",
    "ink": "#eff0f1",
    "muted": "#9c9ea3",
    "accent": "#ff4a1f",
    "accentInk": "#18191b",
    "note": "Graphite and cool light-grey sections alternate, graphite taking about two thirds, and photographs are desaturated so nothing competes. Safety orange marks the buttons, one thick solid bar across the top of the page and the highlighted item in a list or chart.",
    "fields": [
      {
        "bg": "#eff0f1",
        "ink": "#18191b"
      }
    ]
  },
  {
    "id": "soot-pale-lime",
    "name": "Soot and lime",
    "bg": "#0f0f0f",
    "surface": "#1a1a1a",
    "ink": "#ffffff",
    "muted": "#8f8f8f",
    "accent": "#dafa9c",
    "accentInk": "#0f0f0f",
    "note": "A soot-black opening and close bracket white middle sections, all in black, white and grey. Pale lime is the single action colour: every button, and at most one headline set in it on the dark ground.",
    "fields": [
      {
        "bg": "#ffffff",
        "ink": "#0f0f0f"
      },
      {
        "bg": "#dafa9c",
        "ink": "#0f0f0f"
      }
    ]
  },
  {
    "id": "plum-black-pink",
    "name": "Plum-black and pink",
    "bg": "#0d060b",
    "surface": "#1b0e17",
    "ink": "#ffffff",
    "muted": "#9a8f97",
    "accent": "#ff488b",
    "accentInk": "#0d060b",
    "note": "Near-black and plum at the top and bottom bracket a white middle with navy-black text. Hot pink is reserved for primary buttons, bars in charts and map markers; it never fills a section.",
    "fields": [
      {
        "bg": "#470c35",
        "ink": "#ffffff"
      },
      {
        "bg": "#ffffff",
        "ink": "#101421"
      }
    ]
  },
  {
    "id": "white-signal-red",
    "name": "Signal red, white",
    "bg": "#ffffff",
    "surface": "#f2f2f2",
    "ink": "#0a0a0a",
    "muted": "#6b6b6b",
    "accent": "#d92b21",
    "accentInk": "#ffffff",
    "note": "White ground, black text and paper grey for filled panels, with one full black band allowed. Signal red is the only colour in the interface: one word in a headline, a few solid blocks, or the button.",
    "fields": [
      {
        "bg": "#000000",
        "ink": "#ffffff"
      }
    ]
  },
  {
    "id": "white-mint-tiles",
    "name": "Greys and mint",
    "bg": "#ffffff",
    "surface": "#f3f3f3",
    "ink": "#232323",
    "muted": "#6e6e6e",
    "accent": "#a1ffcb",
    "accentInk": "#232323",
    "note": "White, near-black and two greys fill a board of flat tiles. Mint floods a few whole tiles (one statement, one figure, the closing call to action) and appears nowhere else.",
    "fields": [
      {
        "bg": "#a1ffcb",
        "ink": "#232323"
      },
      {
        "bg": "#232323",
        "ink": "#ffffff"
      }
    ]
  },
  {
    "id": "cool-grey-cobalt",
    "name": "Cool grey, cobalt",
    "bg": "#eef0f3",
    "surface": "#e2e5ea",
    "ink": "#0b0c0e",
    "muted": "#5d6470",
    "accent": "#1f2de6",
    "accentInk": "#ffffff",
    "note": "Cool pale grey holds the page with near-black type and nothing else tinted. Cobalt starts as the button and one highlighted sentence, takes one whole section as a flat field with white text, then returns as a single button block.",
    "fields": [
      {
        "bg": "#1f2de6",
        "ink": "#ffffff"
      }
    ]
  },
  {
    "id": "offwhite-bottle-yellow",
    "name": "Bottle ink, yellow",
    "bg": "#f7f7f7",
    "surface": "#ebebeb",
    "ink": "#0d2a1c",
    "muted": "#5f6b64",
    "accent": "#f6e016",
    "accentInk": "#0d2a1c",
    "note": "Off-white ground with all type in a near-black bottle green instead of black. Yellow is the only saturated note: the button or one small object on most screens, and one later section that turns fully yellow.",
    "fields": [
      {
        "bg": "#f6e016",
        "ink": "#0d2a1c"
      }
    ]
  },
  {
    "id": "teal-on-paper",
    "name": "Teal on paper",
    "bg": "#f7f9f8",
    "surface": "#ebf0ee",
    "ink": "#06525c",
    "muted": "#2f737d",
    "accent": "#06525c",
    "accentInk": "#f7f9f8",
    "note": "Cool white paper and a single teal used for every word, shape and button, with no black anywhere. The accent is that same teal filled solid, for the button and for one inverted band with paper-coloured type.",
    "fields": [
      {
        "bg": "#06525c",
        "ink": "#f7f9f8"
      }
    ]
  },
  {
    "id": "navy-pink",
    "name": "Navy and pink",
    "bg": "#1a2039",
    "surface": "#212846",
    "ink": "#f9a3c0",
    "muted": "#b9879c",
    "accent": "#f9a3c0",
    "accentInk": "#1a2039",
    "note": "One navy field runs the entire page. Pink does everything else, from the name and headings to body text, and fills one solid button.",
    "fields": []
  },
  {
    "id": "blush-aubergine",
    "name": "Blush and aubergine",
    "bg": "#edccbe",
    "surface": "#e8c2b2",
    "ink": "#351a2b",
    "muted": "#6c4857",
    "accent": "#351a2b",
    "accentInk": "#edccbe",
    "note": "Blush pink and dark aubergine alternate as full fields and serve as each other's text colour, in roughly equal shares. There is no third colour: the button is a solid block of whichever of the two is not the ground.",
    "fields": [
      {
        "bg": "#351a2b",
        "ink": "#edccbe"
      }
    ]
  },
  {
    "id": "cobalt-on-sand",
    "name": "Cobalt on sand",
    "bg": "#e6dbc7",
    "surface": "#ddd0b9",
    "ink": "#062b8a",
    "muted": "#3a5aa8",
    "accent": "#062b8a",
    "accentInk": "#e6dbc7",
    "note": "Sand paper and one cobalt do everything: text, drawings and solid shapes are all the same blue. The button is a cobalt block with sand-coloured type, and no black or second hue is used.",
    "fields": []
  },
  {
    "id": "oxblood-grey",
    "name": "Oxblood and grey",
    "bg": "#e2e2e2",
    "surface": "#d6d6d6",
    "ink": "#7d0c14",
    "muted": "#7a4a4e",
    "accent": "#7d0c14",
    "accentInk": "#e2e2e2",
    "note": "Deep red text on grey paper holds most of the page, then pale grey text on a solid red field takes one long section and the footer. Photographs are desaturated so nothing breaks the pair, and the button is a solid red block.",
    "fields": [
      {
        "bg": "#7d0c14",
        "ink": "#e2e2e2"
      }
    ]
  },
  {
    "id": "olive-on-bone",
    "name": "Olive on bone",
    "bg": "#ecebe7",
    "surface": "#e1dfd9",
    "ink": "#38450f",
    "muted": "#5d683a",
    "accent": "#38450f",
    "accentInk": "#ecebe7",
    "note": "A bone page with every word, large or small, in one olive green; the footer inverts to a solid olive field with bone text. Photography supplies all other colour, and the button is the same olive, filled.",
    "fields": [
      {
        "bg": "#38450f",
        "ink": "#ecebe7"
      }
    ]
  },
  {
    "id": "burgundy-bubblegum",
    "name": "Burgundy and bubblegum",
    "bg": "#3d0012",
    "surface": "#4d0519",
    "ink": "#ff99d3",
    "muted": "#c77aa0",
    "accent": "#ff99d3",
    "accentInk": "#3d0012",
    "note": "Deep burgundy is the ground for the whole page and bubblegum pink sets every word on it. The button and the active state of a control are solid pink with burgundy type; product photographs supply any other colour.",
    "fields": []
  },
  {
    "id": "bottle-green-gold",
    "name": "Bottle green, gold",
    "bg": "#133621",
    "surface": "#1a4429",
    "ink": "#f4d96c",
    "muted": "#b3a55e",
    "accent": "#f4d96c",
    "accentInk": "#133621",
    "note": "Bottle green covers the page and warm gold sets all the type, with panels one step lighter than the ground. The button is solid gold with green text, and photographs are kept dark and warm so the pair is not disturbed.",
    "fields": []
  },
  {
    "id": "cobalt-field",
    "name": "Cobalt field",
    "bg": "#0034eb",
    "surface": "#002fd6",
    "ink": "#ffffff",
    "muted": "#c5d0ff",
    "accent": "#e9e34a",
    "accentInk": "#111111",
    "note": "One electric cobalt fills everything, with white and pale-blue type; photographs are tinted into blue monotone or kept as small thumbnails. A single yellow dot or button is the only other colour on the page.",
    "fields": []
  },
  {
    "id": "mustard-field",
    "name": "Mustard and black",
    "bg": "#e1ac10",
    "surface": "#cd9d0f",
    "ink": "#0b0b0b",
    "muted": "#4d3d0a",
    "accent": "#24338f",
    "accentInk": "#ffffff",
    "note": "One warm mustard field for the whole page with black ink only. Royal blue is the single interruption, kept to a sliver along one edge or one small button.",
    "fields": []
  },
  {
    "id": "carmine-field",
    "name": "Carmine field",
    "bg": "#9c1220",
    "surface": "#8a101c",
    "ink": "#ffffff",
    "muted": "#f0b9bd",
    "accent": "#ffd9dc",
    "accentInk": "#9c1220",
    "note": "A deep red field bookends or fills the page, with white type and pale pink secondary lines; work shown in between sits on flat charcoal so it keeps its own colours. The button is a pale pink block with red type.",
    "fields": [
      {
        "bg": "#2a2a2a",
        "ink": "#ffffff"
      }
    ]
  },
  {
    "id": "pink-field-lime",
    "name": "Bubblegum and lime",
    "bg": "#ff87ab",
    "surface": "#ff739d",
    "ink": "#0a0a0a",
    "muted": "#6b1f3a",
    "accent": "#def915",
    "accentInk": "#0a0a0a",
    "note": "A flat bubblegum pink field with black type from top to bottom. Fluorescent lime is the action colour only: the menu button, one highlighter swipe behind a word and the main button.",
    "fields": [
      {
        "bg": "#0a0a0a",
        "ink": "#ff87ab"
      }
    ]
  },
  {
    "id": "sky-field-navy",
    "name": "Sky and navy",
    "bg": "#6bb4ee",
    "surface": "#7dbdf0",
    "ink": "#0e1822",
    "muted": "#1b3d5c",
    "accent": "#ff5a1f",
    "accentInk": "#0e1822",
    "note": "Sky blue sits behind everything, white cards lie on top of it, and navy handles all text and the footer. Orange is for buttons and one highlighted word, so orange against blue is the single clash on the page.",
    "fields": [
      {
        "bg": "#ffffff",
        "ink": "#0e1822"
      },
      {
        "bg": "#0e1822",
        "ink": "#ffffff"
      }
    ]
  },
  {
    "id": "orange-field-black",
    "name": "Orange and black",
    "bg": "#ff7a1f",
    "surface": "#ff8633",
    "ink": "#050f16",
    "muted": "#5a2306",
    "accent": "#050f16",
    "accentInk": "#ff7a1f",
    "note": "Hot orange is the page: one flat field with blue-black type, flipping at a hard horizontal seam to a white section when the content needs a rest. The button is a solid block of the same blue-black with orange text, and every other colour comes from the objects shown.",
    "fields": [
      {
        "bg": "#ffffff",
        "ink": "#050f16"
      }
    ]
  },
  {
    "id": "tobacco-olive",
    "name": "Tobacco and olive",
    "bg": "#472913",
    "surface": "#55321a",
    "ink": "#e4e0cf",
    "muted": "#b39f84",
    "accent": "#525e1b",
    "accentInk": "#e4e0cf",
    "note": "Tobacco brown fills the page with bone type, and photographs stay in browns and ochre. One olive block holds the main text or the button, and a single ochre band may break the brown once.",
    "fields": [
      {
        "bg": "#c79a3e",
        "ink": "#2b170a"
      },
      {
        "bg": "#525e1b",
        "ink": "#e4e0cf"
      }
    ]
  },
  {
    "id": "poster-chapters",
    "name": "Poster chapters",
    "bg": "#e6e0d2",
    "surface": "#dcd5c5",
    "ink": "#1a1a1a",
    "muted": "#5f5b52",
    "accent": "#18bc42",
    "accentInk": "#1a1a1a",
    "note": "Each chapter takes one flat field in turn (coral red, near-black, bone, green, yellow) with black or bone type and no tints between them. Green doubles as the accent for the one button when the ground is bone or black.",
    "fields": [
      {
        "bg": "#ed4b44",
        "ink": "#0f0f0f"
      },
      {
        "bg": "#1a1a1a",
        "ink": "#e6e0d2"
      },
      {
        "bg": "#18bc42",
        "ink": "#1a1a1a"
      },
      {
        "bg": "#f2c21a",
        "ink": "#1a1a1a"
      },
      {
        "bg": "#e6e0d2",
        "ink": "#1a1a1a"
      }
    ]
  },
  {
    "id": "blue-red-black",
    "name": "Blue, red, black",
    "bg": "#ffffff",
    "surface": "#f3f3f3",
    "ink": "#0a0a0a",
    "muted": "#6b6b6b",
    "accent": "#2436ff",
    "accentInk": "#ffffff",
    "note": "Three flat poster colours each own whole sections: electric blue, red-orange and black, with white for the areas that show the product. No tints sit between them, and blue is the button colour on white.",
    "fields": [
      {
        "bg": "#2436ff",
        "ink": "#ffffff"
      },
      {
        "bg": "#ff3b1f",
        "ink": "#0a0a0a"
      },
      {
        "bg": "#0a0a0a",
        "ink": "#ffffff"
      },
      {
        "bg": "#050a5c",
        "ink": "#ffffff"
      }
    ]
  },
  {
    "id": "charcoal-primaries",
    "name": "Charcoal and primaries",
    "bg": "#191919",
    "surface": "#242424",
    "ink": "#ffffff",
    "muted": "#9a9a9a",
    "accent": "#0c7866",
    "accentInk": "#ffffff",
    "note": "A charcoal ground holds flat poster primaries assigned to whole panels: red, blue, teal green and yellow, each placed against a different one. Type is white, or black on yellow; teal green is the button colour on charcoal.",
    "fields": [
      {
        "bg": "#d71e1e",
        "ink": "#ffffff"
      },
      {
        "bg": "#1e4bd7",
        "ink": "#ffffff"
      },
      {
        "bg": "#0c7866",
        "ink": "#ffffff"
      },
      {
        "bg": "#ffe927",
        "ink": "#111111"
      }
    ]
  },
  {
    "id": "ultramarine-yellow",
    "name": "Ultramarine and yellow",
    "bg": "#1423b8",
    "surface": "#1220a6",
    "ink": "#ffffff",
    "muted": "#b4bcf0",
    "accent": "#1fc27a",
    "accentInk": "#0a0a0a",
    "note": "Each section is one flat field in sequence: ultramarine, black, yellow, then ultramarine again, with white type on blue and black, and black type on yellow. Green is the only small accent and never grows larger than a button.",
    "fields": [
      {
        "bg": "#1423b8",
        "ink": "#ffffff"
      },
      {
        "bg": "#000000",
        "ink": "#ffffff"
      },
      {
        "bg": "#f7dd47",
        "ink": "#000000"
      },
      {
        "bg": "#e9479f",
        "ink": "#000000"
      }
    ]
  },
  {
    "id": "candy-chapters",
    "name": "Candy chapters",
    "bg": "#ffd249",
    "surface": "#f5c63c",
    "ink": "#0a0a0a",
    "muted": "#5e4a0a",
    "accent": "#f53fd6",
    "accentInk": "#0a0a0a",
    "note": "Each section owns one flat candy colour: yellow first, then white, pink, cyan and orange, with all type in black. Magenta is kept for buttons alone.",
    "fields": [
      {
        "bg": "#ffd249",
        "ink": "#0a0a0a"
      },
      {
        "bg": "#ffffff",
        "ink": "#0a0a0a"
      },
      {
        "bg": "#ffc4ef",
        "ink": "#0a0a0a"
      },
      {
        "bg": "#a4f6f8",
        "ink": "#0a0a0a"
      },
      {
        "bg": "#f9a21f",
        "ink": "#0a0a0a"
      }
    ]
  },
  {
    "id": "orange-sky-lime",
    "name": "Orange, sky, lime",
    "bg": "#ff8126",
    "surface": "#ff8d3a",
    "ink": "#111111",
    "muted": "#5c2a05",
    "accent": "#de194b",
    "accentInk": "#ffffff",
    "note": "The page ground changes as you read: orange first, then sky blue, then acid lime at the end, with one near-black band between; type stays black on all three colours. Crimson is one small button per field.",
    "fields": [
      {
        "bg": "#ff8126",
        "ink": "#111111"
      },
      {
        "bg": "#4db3ff",
        "ink": "#111111"
      },
      {
        "bg": "#c5f53d",
        "ink": "#111111"
      },
      {
        "bg": "#161615",
        "ink": "#f2f2f2"
      }
    ]
  },
  {
    "id": "post-red-mustard",
    "name": "Post red, mustard",
    "bg": "#e2dccf",
    "surface": "#d7d0c1",
    "ink": "#2a1110",
    "muted": "#6b524c",
    "accent": "#4a6f84",
    "accentInk": "#ffffff",
    "note": "Post red and bone alternate as full section fields, with red holding the opening and the close. Mustard, slate blue and maroon are kept for whole card frames, and slate blue also fills the one button.",
    "fields": [
      {
        "bg": "#dc1928",
        "ink": "#ffffff"
      },
      {
        "bg": "#952625",
        "ink": "#ffffff"
      },
      {
        "bg": "#e0a912",
        "ink": "#2a1110"
      },
      {
        "bg": "#4a6f84",
        "ink": "#ffffff"
      },
      {
        "bg": "#e2dccf",
        "ink": "#2a1110"
      }
    ]
  },
  {
    "id": "mint-orange-grey",
    "name": "Grey, mint, orange",
    "bg": "#ffffff",
    "surface": "#f5f5f5",
    "ink": "#000000",
    "muted": "#666666",
    "accent": "#a7ff9c",
    "accentInk": "#000000",
    "note": "Black on white to start, then whole sections flood with flat mid-grey, acid mint and orange in turn. Photographs inside a flooded section are shown in black-and-white, and mint is also the button colour on white and black.",
    "fields": [
      {
        "bg": "#c5c5c5",
        "ink": "#000000"
      },
      {
        "bg": "#a7ff9c",
        "ink": "#000000"
      },
      {
        "bg": "#ff6831",
        "ink": "#000000"
      },
      {
        "bg": "#000000",
        "ink": "#ffffff"
      }
    ]
  },
  {
    "id": "report-blocks",
    "name": "Report blocks",
    "bg": "#ffffff",
    "surface": "#f6f6f6",
    "ink": "#000000",
    "muted": "#5f5f5f",
    "accent": "#fe7141",
    "accentInk": "#000000",
    "note": "A white base with flat blocks of orange, sage, acid yellow and black assigned to whole modules: figure tiles, quote panels and chapter bands. Text is black on every colour and off-white on black, and orange is also the button colour.",
    "fields": [
      {
        "bg": "#fe7141",
        "ink": "#000000"
      },
      {
        "bg": "#d1ddd3",
        "ink": "#000000"
      },
      {
        "bg": "#f0ff1c",
        "ink": "#000000"
      },
      {
        "bg": "#000000",
        "ink": "#f4f4f4"
      }
    ]
  },
  {
    "id": "card-pastels",
    "name": "Card pastels",
    "bg": "#f7f7f5",
    "surface": "#ebebe8",
    "ink": "#000000",
    "muted": "#666662",
    "accent": "#d0106f",
    "accentInk": "#ffffff",
    "note": "Neutral paper ground and black type, with each card or tile given its own flat pastel (periwinkle, lime, amber or cyan), never two alike side by side. Magenta is reserved for the logo, the email address and text links.",
    "fields": [
      {
        "bg": "#97aaf6",
        "ink": "#000000"
      },
      {
        "bg": "#bbf697",
        "ink": "#000000"
      },
      {
        "bg": "#fed878",
        "ink": "#000000"
      },
      {
        "bg": "#6ef8fb",
        "ink": "#000000"
      }
    ]
  },
  {
    "id": "mint-pink-accounts",
    "name": "Mint and pink",
    "bg": "#f8f8f8",
    "surface": "#eeeeee",
    "ink": "#0a0a0a",
    "muted": "#6a6a6a",
    "accent": "#1f6b3a",
    "accentInk": "#ffffff",
    "note": "Near-white base with black type; mint and pink are the only two colours and each stands for one side of the product. They first appear as small circles, then as full-screen section fields, and deep green is used only for the button.",
    "fields": [
      {
        "bg": "#c3edce",
        "ink": "#0a0a0a"
      },
      {
        "bg": "#f8c7c9",
        "ink": "#0a0a0a"
      },
      {
        "bg": "#ffffff",
        "ink": "#0a0a0a"
      }
    ]
  },
  {
    "id": "swap-pastels",
    "name": "Swapping pastels",
    "bg": "#c3cbe5",
    "surface": "#d0d6eb",
    "ink": "#141414",
    "muted": "#4a5068",
    "accent": "#0f5257",
    "accentInk": "#ffffff",
    "note": "One flat pastel is the whole background and it swaps per project or chapter: periwinkle, pink, sand, sage, peach. Type and one solid box stay near-black on all five, and dark teal is only for the button.",
    "fields": [
      {
        "bg": "#c3cbe5",
        "ink": "#141414"
      },
      {
        "bg": "#efd3da",
        "ink": "#141414"
      },
      {
        "bg": "#e6dccd",
        "ink": "#141414"
      },
      {
        "bg": "#cfd3cb",
        "ink": "#141414"
      },
      {
        "bg": "#f9cdbd",
        "ink": "#141414"
      }
    ]
  },
  {
    "id": "blush-sage-slate",
    "name": "Blush, sage, slate",
    "bg": "#a6b3bc",
    "surface": "#b2bdc5",
    "ink": "#1c1c1c",
    "muted": "#38424a",
    "accent": "#2c3620",
    "accentInk": "#e3e2da",
    "note": "Slate blue-grey, sage and blush share the page as soft flat blocks, one per chapter or menu tile, with dark type; one deep olive block anchors the close with pale type. Olive is also the button colour, and photographs of sea and sky do the rest.",
    "fields": [
      {
        "bg": "#a6b3bc",
        "ink": "#1c1c1c"
      },
      {
        "bg": "#b7c8be",
        "ink": "#1c1c1c"
      },
      {
        "bg": "#d6c4b8",
        "ink": "#1c1c1c"
      },
      {
        "bg": "#2c3620",
        "ink": "#e3e2da"
      }
    ]
  },
  {
    "id": "candy-on-black",
    "name": "Candy on black",
    "bg": "#000000",
    "surface": "#0d0d0d",
    "ink": "#ffffff",
    "muted": "#999999",
    "accent": "#93f1f7",
    "accentInk": "#000000",
    "note": "Black ground and dark photographs take nearly all of the surface. The only flat colour is a solid block behind each title, which takes a new candy pastel per project (mint, cyan, lemon, orange, cornflower); cyan is the default for the button.",
    "fields": [
      {
        "bg": "#9ae187",
        "ink": "#000000"
      },
      {
        "bg": "#93f1f7",
        "ink": "#000000"
      },
      {
        "bg": "#f3ea7a",
        "ink": "#000000"
      },
      {
        "bg": "#fbb65c",
        "ink": "#000000"
      },
      {
        "bg": "#b9c8ff",
        "ink": "#000000"
      }
    ]
  },
  {
    "id": "sky-sand",
    "name": "Sky and sand",
    "bg": "#cbe4f2",
    "surface": "#bcdcee",
    "ink": "#0a0a0a",
    "muted": "#44606e",
    "accent": "#b0298f",
    "accentInk": "#ffffff",
    "note": "Sky blue and sand yellow are the constant ground, each holding whole sections, with black text throughout. Saturated colour arrives only as small solid objects, and magenta is kept for the contact card and its button.",
    "fields": [
      {
        "bg": "#cbe4f2",
        "ink": "#0a0a0a"
      },
      {
        "bg": "#f1e3b5",
        "ink": "#0a0a0a"
      },
      {
        "bg": "#ffc013",
        "ink": "#0a0a0a"
      },
      {
        "bg": "#0a0a0a",
        "ink": "#f2f2f2"
      }
    ]
  },
  {
    "id": "studio-grey",
    "name": "Studio grey",
    "bg": "#a8a8aa",
    "surface": "#b4b4b6",
    "ink": "#0e0e0e",
    "muted": "#3a3a3c",
    "accent": "#1f5c49",
    "accentInk": "#ffffff",
    "note": "One mid grey serves as both page and studio backdrop, so the photographed object seems to stand on the page itself; type is black and one black band comes late. Colour comes only from the product, and racing green is for the single button.",
    "fields": [
      {
        "bg": "#1b1b1c",
        "ink": "#ffffff"
      }
    ]
  },
  {
    "id": "walnut-tan",
    "name": "Walnut and tan",
    "bg": "#2b2216",
    "surface": "#382d1e",
    "ink": "#e4e2da",
    "muted": "#a39a8b",
    "accent": "#bda38b",
    "accentInk": "#2b2216",
    "note": "Dark walnut holds the opening and the close with bone type, and the middle of the page may turn to flat tan around honey-lit photographs. There is no bright accent: tan is the fill for the one button on walnut.",
    "fields": [
      {
        "bg": "#bda38b",
        "ink": "#1c150d"
      }
    ]
  }
];
