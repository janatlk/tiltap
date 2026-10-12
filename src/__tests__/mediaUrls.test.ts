import { test } from "node:test";
import assert from "node:assert/strict";
import { isSupportedMediaUrl, detectMediaSource } from "../services/youtubeService";

/**
 * Ссылка, которую не узнали, уходит в перевод как обычный текст, и человек
 * получает обратно свой же адрес. Так пришла жалоба "видео не переводит":
 * кнопка "Поделиться" в инстаграме даёт /reels/, а шаблон знал только /reel/.
 */
test("инстаграм: принимаем все ходовые виды ссылок", () => {
  const accepted = [
    "https://www.instagram.com/reels/DceHGuPN3rb/",
    "https://www.instagram.com/reel/DcEAdKOMZQ3/",
    "https://instagram.com/reels/xyz/",
    "https://www.instagram.com/username/reel/DcE123/",
    "https://www.instagram.com/p/ABC123/",
    "https://www.instagram.com/tv/ABC123/",
    "https://www.instagram.com/share/BAdBNxxy9w/",
  ];
  for (const url of accepted) {
    assert.equal(isSupportedMediaUrl(url), true, url);
    assert.equal(detectMediaSource(url), "instagram", url);
  }
});

test("инстаграм: страницы без видео не принимаем за ссылку на запись", () => {
  assert.equal(isSupportedMediaUrl("https://www.instagram.com/accounts/login/"), false);
});

test("остальные площадки на месте", () => {
  const cases: [string, string][] = [
    ["https://www.youtube.com/watch?v=jNQXAC9IVRw", "youtube"],
    ["https://youtu.be/jNQXAC9IVRw", "youtube"],
    ["https://vm.tiktok.com/ZMabc/", "tiktok"],
    ["https://www.facebook.com/watch/?v=4451031388504983", "facebook"],
    ["https://fb.watch/abcdef/", "facebook"],
  ];
  for (const [url, source] of cases) {
    assert.equal(isSupportedMediaUrl(url), true, url);
    assert.equal(detectMediaSource(url), source, url);
  }
});

test("посторонние ссылки остаются текстом", () => {
  for (const url of ["https://example.com/video.mp4", "https://www.threads.com/@user/post/DcV1", "просто текст"]) {
    assert.equal(isSupportedMediaUrl(url), false, url);
  }
});
