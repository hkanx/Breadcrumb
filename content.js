(function () {
  const CONTENT_SELECTORS = [
    "article",
    "main article",
    "main",
    ".job-description",
    "#job-details",
    "#jobDescriptionText",
    "[data-testid='job-description']",
    "[data-qa='job-description']",
    "[class*='job-description']",
    "[class*='description']",
    "section[class*='description']"
  ];

  const NOISE_SELECTORS = [
    "script",
    "style",
    "iframe",
    "noscript",
    "svg",
    "canvas",
    "form",
    "button",
    "input",
    "select",
    "textarea",
    "nav",
    "footer",
    "header",
    "[aria-hidden='true']",
    "[role='navigation']",
    "[class*='cookie']",
    "[class*='consent']",
    "[class*='modal']",
    "[class*='banner']",
    "[class*='share']",
    "[class*='social']"
  ];

  const SECTION_HINTS = [
    "about the role",
    "job description",
    "responsibilities",
    "what you'll do",
    "requirements",
    "qualifications",
    "benefits",
    "compensation",
    "salary"
  ];

  function normalizeWhitespace(text) {
    return text
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function normalizeLines(text) {
    const lines = (text || "")
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trim())
      .filter((line) => line.length > 0);

    return normalizeWhitespace(lines.join("\n"));
  }

  function removeNoise(root) {
    NOISE_SELECTORS.forEach((selector) => {
      root.querySelectorAll(selector).forEach((node) => node.remove());
    });

    root.querySelectorAll("*").forEach((node) => {
      const className = (node.className || "").toString().toLowerCase();
      const id = (node.id || "").toLowerCase();
      const hasNoisyName = /(cookie|consent|subscribe|share|social|modal|dialog|recommend|similar)/.test(`${className} ${id}`);
      if (hasNoisyName) {
        node.remove();
      }
    });
  }

  function nodeScore(node) {
    const text = normalizeLines(node.innerText || node.textContent || "");
    if (!text) {
      return { score: 0, sectionHits: 0 };
    }

    let score = Math.min(text.length, 5000) / 50;

    const nameBlob = `${(node.tagName || "").toLowerCase()} ${(node.className || "").toString().toLowerCase()} ${(node.id || "").toLowerCase()}`;
    if (/job|description|posting|detail|content|role/.test(nameBlob)) {
      score += 40;
    }

    const lowerText = text.toLowerCase();
    let sectionHits = 0;
    SECTION_HINTS.forEach((hint) => {
      if (lowerText.includes(hint)) {
        score += 15;
        sectionHits += 1;
      }
    });

    const headingCount = node.querySelectorAll("h1,h2,h3,h4").length;
    const listCount = node.querySelectorAll("li").length;
    score += headingCount * 2;
    score += Math.min(listCount, 40) * 0.8;

    return { score, sectionHits };
  }

  function getCandidates() {
    const candidates = new Set();

    CONTENT_SELECTORS.forEach((selector) => {
      document.querySelectorAll(selector).forEach((node) => candidates.add(node));
    });

    document.querySelectorAll("section, article, div").forEach((node) => {
      const nameBlob = `${(node.className || "").toString().toLowerCase()} ${(node.id || "").toLowerCase()}`;
      if (/job|description|posting|detail|responsibilit|qualification|requirement/.test(nameBlob)) {
        candidates.add(node);
      }
    });

    return Array.from(candidates);
  }

  function uniqueByText(blocks) {
    const seen = new Set();
    const result = [];

    blocks.forEach((block) => {
      const key = block.toLowerCase().slice(0, 500);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(block);
      }
    });

    return result;
  }

  function scoreConfidence({ extractedLength, sectionHits, candidateCount, topScore }) {
    let confidence = 0;

    if (extractedLength >= 500) {
      confidence += 0.3;
    }
    if (extractedLength >= 1500) {
      confidence += 0.2;
    }

    confidence += Math.min(sectionHits * 0.08, 0.24);
    confidence += Math.min(candidateCount * 0.04, 0.16);

    if (topScore > 120) {
      confidence += 0.1;
    }

    return Math.min(1, Number(confidence.toFixed(2)));
  }

  function extractCleanText() {
    const candidates = getCandidates();

    const scoredBlocks = candidates
      .map((node) => {
        const clone = node.cloneNode(true);
        removeNoise(clone);
        const text = normalizeLines(clone.innerText || clone.textContent || "");
        const scoring = nodeScore(clone);
        return {
          text,
          score: scoring.score,
          sectionHits: scoring.sectionHits
        };
      })
      .filter((item) => item.text.length > 200)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);

    const mergedBlocks = uniqueByText(scoredBlocks.map((item) => item.text));
    const mergedText = mergedBlocks.join("\n\n").trim();

    if (mergedText.length >= 300) {
      const sectionHits = scoredBlocks.reduce((sum, item) => sum + item.sectionHits, 0);
      return {
        text: mergedText,
        confidence: scoreConfidence({
          extractedLength: mergedText.length,
          sectionHits,
          candidateCount: candidates.length,
          topScore: scoredBlocks[0]?.score || 0
        }),
        sectionHits
      };
    }

    const bodyClone = document.body.cloneNode(true);
    removeNoise(bodyClone);
    const fallbackText = normalizeLines(bodyClone.innerText || bodyClone.textContent || "");

    return {
      text: fallbackText,
      confidence: scoreConfidence({
        extractedLength: fallbackText.length,
        sectionHits: 0,
        candidateCount: candidates.length,
        topScore: 0
      }),
      sectionHits: 0
    };
  }

  function scrapeJobPage() {
    const extracted = extractCleanText();

    return {
      title: document.title || "Untitled Page",
      cleanedText: extracted.text,
      confidence: extracted.confidence,
      sectionHints: SECTION_HINTS.filter((hint) => extracted.text.toLowerCase().includes(hint)),
      url: window.location.href
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "SCRAPE_JOB_DETAILS" && message?.type !== "BREADCRUMB_TRIGGER") {
      return;
    }

    try {
      const result = scrapeJobPage();
      sendResponse({ ok: true, data: result });
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : "Unknown scrape error" });
    }

    return true;
  });
})();
