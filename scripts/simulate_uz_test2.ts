async function main() {
  const update = {
    update_id: 999999995,
    callback_query: {
      id: "test_uz_callback_2",
      from: {
        id: 5206327279,
        is_bot: false,
        first_name: "Janat",
        username: "jj07n",
        language_code: "uz",
      },
      message: {
        message_id: 996,
        chat: {
          id: 5206327279,
          first_name: "Janat",
          username: "jj07n",
          type: "private",
        },
        date: Math.floor(Date.now() / 1000),
        text: "choose test language",
      },
      data: "test_lang:uz",
    },
  };

  const res = await fetch("http://localhost:3000/webhook/telegram", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
    signal: AbortSignal.timeout(120000),
  });
  console.log("status", res.status);
  const text = await res.text();
  console.log(text.slice(0, 500));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
