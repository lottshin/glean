/*
 * Bilibili subtitle probe.
 *
 * Answers one question before we build anything else: do the videos you
 * actually want to study have a usable subtitle track, and in which language?
 *
 * How to run
 *   1. Open https://www.bilibili.com in Chrome and make sure you are signed in.
 *      Bilibili returns an empty subtitle list to anonymous callers, so being
 *      signed in is required — a signed-out run reports "no subtitles" for
 *      every video regardless of the truth.
 *   2. Open DevTools (F12) -> Console.
 *   3. Paste this whole file and press Enter.
 *   4. Call it with the videos you care about:
 *
 *        gleanProbe([
 *          'BV1GJ411x7h7',
 *          'https://www.bilibili.com/video/BV1xx411c7mD',
 *        ]);
 *
 *      Or probe the page you are currently on:
 *
 *        gleanProbe();
 *
 * Everything here is read-only: it calls the same public endpoints the site
 * itself uses and reuses the session already in the browser.
 */

(() => {
	const BV_PATTERN = /BV1[1-9A-HJ-NP-Za-km-z]{9}/;

	function toBvid(input) {
		const match = String(input).match(BV_PATTERN);
		return match ? match[0] : null;
	}

	function pageOf(input) {
		const match = String(input).match(/[?&]p=(\d+)/);
		return match ? Number(match[1]) : 1;
	}

	async function getJson(url) {
		const response = await fetch(url, { credentials: 'include' });
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		return response.json();
	}

	async function probeOne(input) {
		const bvid = toBvid(input);
		if (!bvid) {
			return { 输入: String(input), 状态: 'BV 号无法识别' };
		}

		const view = await getJson(
			`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
		);
		if (!view || view.code !== 0 || !view.data) {
			return { 输入: bvid, 状态: `取视频信息失败（code ${view && view.code}）` };
		}

		const pages = Array.isArray(view.data.pages) ? view.data.pages : [];
		const wanted = pageOf(input);
		const part = pages.find((p) => p.page === wanted) || pages[0];
		if (!part) {
			return { 输入: bvid, 标题: view.data.title, 状态: '没有分P' };
		}

		const player = await getJson(
			`https://api.bilibili.com/x/player/v2?aid=${view.data.aid}&cid=${part.cid}`,
		);
		const list =
			(player && player.data && player.data.subtitle && player.data.subtitle.subtitles) ||
			[];

		const langs = list
			.filter((s) => s.subtitle_url)
			.map((s) => `${s.lan}${s.lan.startsWith('ai-') ? '(AI)' : ''}`);
		const english = langs.filter((l) => l.replace('ai-', '').startsWith('en'));

		return {
			输入: bvid,
			标题: String(view.data.title || '').slice(0, 30),
			字幕轨数: langs.length,
			语言: langs.join(', ') || '—',
			有英文: english.length > 0 ? '是' : '否',
			状态: langs.length ? 'OK' : '无字幕',
		};
	}

	window.gleanProbe = async function gleanProbe(inputs) {
		const targets =
			Array.isArray(inputs) && inputs.length ? inputs : [location.href];

		const rows = [];
		for (const target of targets) {
			try {
				rows.push(await probeOne(target));
			} catch (error) {
				rows.push({ 输入: String(target), 状态: `出错：${error.message}` });
			}
		}

		console.table(rows);

		const withSubs = rows.filter((r) => r.状态 === 'OK');
		const withEnglish = rows.filter((r) => r.有英文 === '是');
		console.log(
			`\n共 ${rows.length} 个视频：${withSubs.length} 个有字幕，其中 ${withEnglish.length} 个有英文轨。`,
		);
		if (withSubs.length === 0) {
			console.log(
				'全部没有字幕。请先确认右上角是登录状态 —— 未登录时接口一律返回空。',
			);
		}
		return rows;
	};

	console.log(
		'已就绪。运行 gleanProbe() 查当前页，或 gleanProbe([\'BV...\', \'BV...\']) 批量查。',
	);
})();
