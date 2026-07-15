require("dotenv").config();

const { cleanupTranscription } = require("../dist/services/cleanupService");
const { translateText } = require("../dist/services/translationService");

const samples = [
  {
    lang: "tg",
    text: ", ҷуддум. и муқаддаси Аллоҳи меҳрубона бубинм ва рафта будам ҳаҷвомра ва бисёр орзу доштм. Ман меша орзу мекардм, ки дар 33 солагӣ ман бояд ки бурум онҷора бубинм. Ва Худованд марая қадар дӯстм дошт, ки боз ман рафтам дидам, боз пас омадам. Худоро шукр. Ташукр. Боз ҳам мунтақидини шумо болои шумо интиқот мекунанд, вай тамом мебанданд, ки шумо вақте ки ҳаҷ кардед, бо вуҷуд аз бо ҳам бисёр",
    targets: ["ru", "en"],
  },
  {
    lang: "ky",
    text: "бакыт каалап койгон ордуна бузулган адамдар дагы бул ойго кеткен мен ошондо абдан таң калдым мен элдин баарын өзүндөй ойлой беришкен нерсе болуп бизге биз жөнүндө сөз болуп турганы бул биздин чыгармачылыктагы орду үйдөгүнүн кабар берет чындыгында андай эркек өзүнүн стилин такыр баягы отурбай бербей ошол соң сиз айткан нак мак кыргызстанда жалгыз пирматов эгерде таңгаласың да кудайга шүгүр кийин миллион алып бардык жеке пайда болуп алдыда сиздин үй-бүлө деп калдыңыз үй-бүлөңүз эки жолго түшкөнүн баарыбыз барбыз глистов анын мына ушул эки жолго түшүүдөн сиз кандай сабак алдыңыз сиздин сизде үй-бүлө деп калдыңыз мына ушул үй-бүлөңүз эки жолго түшкөнүн баарыбыз люстранын мына ушул эки жолго түшүүдөн сиз кандай сабак алдыңыз сыноодон негизги сүзүлүп",
    targets: ["ru", "en"],
  },
  {
    lang: "uz",
    text: "men hozir sizlarga ma'lumot beradigan kitoblarimni hayotingiz davomida mutlaqo o'qiy ko'rmang. men chunki jiddiy gapiryapman. ayrim marketologlarning turli xil chiroyli reklamalari asosida siz ushbu kitoblarni nomiga uchib olib qo'yasiz. jumladan, meni ranjita olmaysiz. mudhish psixologiyada nomlangan ushbu kitobni mutlaqo o'qishni tavsiya qilmayman. nimaga? xuddi bu ushbu kitob ichidagi ma'lumotlar google tarjimidan to'g'ridan to'g'ri tarjima qilinib, bosmaxonadan chiqarilayotganga o'xshaydi va sizni olayotgan pulingizga ham, o'qiyot ganda ketkazadigan vaqtingizga ham mutlaqo arzimaydi. uning o'rniga qanday kitoblarni o'qish kerak? hozirgi kunda meni ranjita olmaysiz, kechirishni o'rgandim, ba'zilar olisdan sevarlar kabi turli xil psixologik o'yinlar orqali chiqarilayotgan kitoblar insonlarni birdan diqqat markaziga tushib, ha? shu kabi kitoblar sizni e'tiboringizni jalb qilib, sizni vaqtingizni o'g'irlashga yordam beradi. aslida esa agarda siz o'zingizni eng qadringizni bilsangiz yoki o'zingizni shaxsiyatingizni rivojlantirishni xohlasangiz, mudh psixologiya, men kechirishni o'rgandim kabi kitoblarga mutlaqo murojaat qilishni maslahat bermayman.",
    targets: ["ru", "en"],
  },
];

async function main() {
  for (const sample of samples) {
    console.log(`\n========== ${sample.lang.toUpperCase()} ==========`);
    console.log("--- raw ---");
    console.log(sample.text);

    const cleanup = await cleanupTranscription(sample.text, sample.lang);
    console.log("\n--- cleaned ---");
    console.log(`provider: ${cleanup.provider}, model: ${cleanup.model}`);
    if (cleanup.warning) console.log("warning:", cleanup.warning);
    console.log(cleanup.cleanedText);

    for (const target of sample.targets) {
      const result = await translateText({
        text: cleanup.cleanedText,
        sourceLang: sample.lang,
        targetLang: target,
      });
      console.log(`\n--- translation ${sample.lang} -> ${target} ---`);
      console.log(`requestId: ${result.requestId}, cost: $${result.costUsd ?? "?"}`);
      if (result.warning) console.log("warning:", result.warning);
      console.log(result.translatedText);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
