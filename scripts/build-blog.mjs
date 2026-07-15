import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import matter from 'gray-matter';
import hljs from 'highlight.js';
import { marked } from 'marked';
import { markedHighlight } from 'marked-highlight';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentDir = path.join(rootDir, 'content', 'blog');
const outputDir = path.join(rootDir, 'blog');
const templatesDir = path.join(rootDir, 'templates');

marked.use(markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, language) {
        const grammar = language && hljs.getLanguage(language) ? language : 'plaintext';
        return hljs.highlight(code, { language: grammar, ignoreIllegals: true }).value;
    }
}));

const escapeHtml = (value) => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

function renderTemplate(template, values) {
    let result = template;

    for (const [name, value] of Object.entries(values)) {
        result = result.replaceAll(`{{${name}}}`, value);
    }

    const unresolved = result.match(/{{[A-Z_]+}}/g);
    if (unresolved) {
        throw new Error(`Missing template values: ${[...new Set(unresolved)].join(', ')}`);
    }

    return result;
}

function parseDate(value, sourcePath) {
    const date = value instanceof Date ? value : new Date(`${value}T00:00:00Z`);

    if (!value || Number.isNaN(date.getTime())) {
        throw new Error(`${sourcePath}: frontmatter must include a valid date`);
    }

    return {
        iso: date.toISOString().slice(0, 10),
        display: new Intl.DateTimeFormat('en', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            timeZone: 'UTC'
        }).format(date)
    };
}

async function loadPosts() {
    const entries = await readdir(contentDir, { withFileTypes: true });
    const postDirectories = entries.filter((entry) => entry.isDirectory());

    return Promise.all(postDirectories.map(async (entry) => {
        const slug = entry.name;
        const sourceDir = path.join(contentDir, slug);

        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
            throw new Error(`${sourceDir}: directory name must be a lowercase URL slug`);
        }

        const sourceEntries = await readdir(sourceDir, { withFileTypes: true });
        const markdownFiles = sourceEntries.filter((sourceEntry) =>
            sourceEntry.isFile() && path.extname(sourceEntry.name).toLowerCase() === '.md'
        );

        if (markdownFiles.length !== 1) {
            throw new Error(`${sourceDir}: post directory must contain exactly one Markdown file`);
        }

        const sourceFilename = markdownFiles[0].name;
        const sourcePath = path.join(sourceDir, sourceFilename);

        const source = await readFile(sourcePath, 'utf8');
        const { data, content } = matter(source);
        const titleToken = marked.lexer(content).find((token) => token.type === 'heading' && token.depth === 1);

        if (!titleToken) {
            throw new Error(`${sourcePath}: post must include a level-one heading (# Title)`);
        }

        if (typeof data.description !== 'string' || !data.description.trim()) {
            throw new Error(`${sourcePath}: frontmatter must include a description`);
        }

        const title = titleToken.text.trim();
        const date = parseDate(data.date, sourcePath);
        const html = await marked.parse(content);

        return {
            slug,
            sourceDir,
            sourceFilename,
            title,
            description: data.description.trim(),
            date,
            html: html.replaceAll('<img ', '<img loading="lazy" decoding="async" ')
        };
    }));
}

async function copyPostAssets(sourceDir, sourceFilename, destinationDir) {
    const entries = await readdir(sourceDir, { withFileTypes: true });

    await Promise.all(entries
        .filter((entry) => entry.name !== sourceFilename)
        .map((entry) => cp(
            path.join(sourceDir, entry.name),
            path.join(destinationDir, entry.name),
            { recursive: true }
        )));
}

async function build() {
    const [indexTemplate, postTemplate] = await Promise.all([
        readFile(path.join(templatesDir, 'blog-index.html'), 'utf8'),
        readFile(path.join(templatesDir, 'blog-post.html'), 'utf8')
    ]);
    const posts = (await loadPosts()).sort((a, b) => b.date.iso.localeCompare(a.date.iso));

    await rm(outputDir, { recursive: true, force: true });
    await mkdir(outputDir, { recursive: true });

    const postList = posts.map((post) => `
                    <article class="blog-list-item">
                        <time datetime="${post.date.iso}">${escapeHtml(post.date.display)}</time>
                        <h2><a href="/blog/${post.slug}/">${escapeHtml(post.title)}</a></h2>
                        <p>${escapeHtml(post.description)}</p>
                    </article>`).join('');

    const indexHtml = renderTemplate(indexTemplate, { POST_LIST: postList });
    await writeFile(path.join(outputDir, 'index.html'), indexHtml);

    await Promise.all(posts.map(async (post) => {
        const postOutputDir = path.join(outputDir, post.slug);
        await mkdir(postOutputDir, { recursive: true });

        const html = renderTemplate(postTemplate, {
            PAGE_TITLE: escapeHtml(`${post.title} - Illia Rudyi`),
            DESCRIPTION: escapeHtml(post.description),
            CANONICAL_URL: `https://illiadot.dev/blog/${post.slug}/`,
            DATE_ISO: post.date.iso,
            DATE_DISPLAY: escapeHtml(post.date.display),
            POST_CONTENT: post.html
        });

        await Promise.all([
            writeFile(path.join(postOutputDir, 'index.html'), html),
            copyPostAssets(post.sourceDir, post.sourceFilename, postOutputDir)
        ]);
    }));

    console.log(`Generated ${posts.length} blog post${posts.length === 1 ? '' : 's'}.`);
}

build().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
