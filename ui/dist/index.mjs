import { activeLocale, fmtDateTime, useAppApi, useChatLauncher, useLanguageGeneration } from "@kirocrew/app-sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Heart, MessageCircleQuestion, Music, Play, Search, ShieldCheck, SkipForward, Sparkles, Waves } from "lucide-react";
import { Btn, EmptyState, ErrorNotice, PageHeader, SegmentedControl } from "@kirocrew/app-sdk/ui";
import { jsx, jsxs } from "react/jsx-runtime";
// src/i18n.ts
/**
* The app's own strings. A bundle cannot read the dashboard's catalogs (those
* belong to the host and change with it), so every locale the dashboard ships is
* bundled here and looked up against the host's active language.
*
* Lookup order: the exact locale (`pt`, `zh-CN`), then its base language, then
* English, then the key itself, so a missing translation shows English rather
* than nothing. `{{name}}` placeholders are filled from `vars`; one with no value
* is left as written.
*
* `t` reads the language at call time. The root component subscribes to the
* host's language changes (`useLanguageGeneration`), and its re-render reaches
* every child, so a language switch repaints the page without a reload.
*/
var CATALOGS = {
	bn: {
		manifest: {
			"display_name": "মুড মিউজিক",
			"description": "বলুন আপনি কেমন বোধ করছেন, বা এমন একটি গান যা আপনাকে ছুঁয়ে গেছে। DJ এজেন্ট একই অনুভূতির গান খুঁজে বাজায়: YouTube পেজের ভেতরে, bilibili ব্রাউজারের নতুন ট্যাবে। পছন্দ বা বাদ দিন, পরের বাছাই সেই অনুযায়ী বদলাবে।",
			"page_label": "মুড মিউজিক",
			"highlight_1": "আপনার মুড বা মন ছুঁয়ে যাওয়া গানটি বলুন — একই অনুভূতির আরও গান খুঁজে দেয়",
			"highlight_2": "প্রতিটি গানের সঙ্গে বলা থাকে কেন এটি এই মুডে মানায়",
			"highlight_3": "YouTube গোপনীয়তা-উন্নত এম্বেডে পেজের ভেতরে বাজে",
			"highlight_4": "bilibili-র গান আপনার নিজের ব্রাউজারের নতুন ট্যাবে খোলে; এজেন্ট কখনো আপনার অ্যাকাউন্ট ছোঁয় না",
			"highlight_5": "পছন্দ বা বাদ দেওয়া পরের বাছাইয়ে কাজে লাগে",
			"highlight_6": "পটভূমি আর নড়াচড়া মুডের সঙ্গে বদলায়, লাইট ও ডার্ক দুটোতেই",
			"use_case_1": "এখনকার মুডের সঙ্গে মেলে এমন গান খুঁজে বাজান, আর মন ছুঁয়ে যাওয়া মুহূর্তগুলো রেখে দিন।",
			"configuration_1": "কোনো অ্যাকাউন্ট লাগে না। YouTube পেজে বাজে; bilibili আপনার নিজের ব্রাউজারে খোলে, সাইন ইন করা থাকুক বা না থাকুক।"
		},
		page: {
			"title": "মুড মিউজিক",
			"subtitle": "এখনকার মুডের গান",
			"tab_listen": "শুনুন",
			"tab_moments": "মুহূর্ত",
			"mood_label": "আপনি কেমন বোধ করছেন, বা কোন গান আপনাকে ছুঁয়ে গেছে?",
			"mood_placeholder": "বৃষ্টির সন্ধ্যা, বাড়ির কথা মনে পড়ছে — বা কোনো গানের নাম",
			"find": "গান খুঁজুন",
			"finding": "মানানসই গান খুঁজছি…",
			"mood_chips": "মুড",
			"mood_calm": "শান্ত",
			"mood_sad": "দুঃখী",
			"mood_happy": "খুশি",
			"mood_missing": "মনে পড়া",
			"mood_fired": "উদ্দীপ্ত",
			"question_label": "DJ জানতে চায়",
			"answer_placeholder": "আপনার উত্তর",
			"send_answer": "উত্তর দিন",
			"empty_title": "এখনো কিছু বাজছে না",
			"empty_body": "আপনার মুড বলুন, বা ওপর থেকে একটি বেছে নিন।",
			"now_playing": "এখন বাজছে",
			"why": "কেন মানায়",
			"like": "পছন্দ",
			"liked": "পছন্দ করেছেন",
			"skip": "বাদ দিন",
			"more": "এমন আরও",
			"open_bilibili": "bilibili-তে খুলুন",
			"bilibili_note": "আপনার নিজের ব্রাউজারের নতুন ট্যাবে খোলে।",
			"queue": "এরপর",
			"play": "{{title}} বাজান",
			"player_title": "YouTube প্লেয়ার: {{title}}",
			"pause_motion": "পটভূমির নড়াচড়া থামান",
			"play_motion": "পটভূমির নড়াচড়া চালান",
			"moments_empty_title": "এখনো কোনো মুহূর্ত নেই",
			"moments_empty_body": "আপনি যে মুড শেয়ার করেন, তা তার গানগুলোর সঙ্গে এখানে থাকে।",
			"error_generic": "কিছু ভুল হয়েছে ({{code}})",
			"error_unreadable": "DJ-এর উত্তর পড়া যায়নি। আবার চেষ্টা করুন।",
			"error_all_dropped": "DJ {{count}}টি গান পেয়েছে, কিন্তু কোনোটিই এমনভাবে আসেনি যা পেজ চালাতে পারে।",
			"retry": "আবার জিজ্ঞেস করুন",
			"error_timeout": "DJ অনেক দেরি করেছে। আবার চেষ্টা করুন।",
			"approval_title": "DJ ওয়েবে খোঁজার জন্য আপনার অনুমতির অপেক্ষায় আছে",
			"approval_step_open": "নিচের বোতাম দিয়ে DJ-এর চ্যাট খুলুন।",
			"approval_step_trust": "সেখানে ওয়েব খোঁজার অনুমতি দিন। বিশ্বাস বেছে নিলে আর জিজ্ঞেস করবে না।",
			"approval_step_back": "এখানে ফিরে আসুন। গানগুলো নিজে থেকেই দেখা যাবে।",
			"approval_open": "DJ-এর চ্যাট খুলুন",
			"dropped": "যে গানের লিংক বাজানো যায় না, সেগুলো বাদ: {{count}}",
			"source_youtube": "YouTube",
			"source_bilibili": "bilibili"
		}
	},
	de: {
		manifest: {
			"display_name": "Mood Music",
			"description": "Sag, wie du dich fühlst, oder nenne einen Song, der dich berührt hat. Ein DJ-Agent findet Songs mit demselben Gefühl und spielt sie ab: YouTube direkt auf der Seite, bilibili in einem neuen Browser-Tab. Mit Gefällt mir oder Überspringen richten sich die nächsten Vorschläge danach.",
			"page_label": "Mood Music",
			"highlight_1": "Sag, wie du dich fühlst, oder nenne einen Song, der dich berührt hat – er findet mehr mit demselben Gefühl",
			"highlight_2": "Jeder Vorschlag sagt, warum er zur Stimmung passt",
			"highlight_3": "YouTube läuft auf der Seite über die datenschutzfreundliche Einbettung",
			"highlight_4": "bilibili-Songs öffnen sich in einem neuen Tab deines eigenen Browsers; der Agent rührt dein Konto nie an",
			"highlight_5": "Gefällt mir oder Überspringen fließt in die nächsten Vorschläge ein",
			"highlight_6": "Hintergrund und Bewegung folgen der Stimmung, hell wie dunkel",
			"use_case_1": "Songs finden und abspielen, die zu deiner jetzigen Stimmung passen, und die Momente festhalten, die dich berührt haben.",
			"configuration_1": "Kein Konto nötig. YouTube läuft auf der Seite; bilibili öffnet sich in deinem eigenen Browser, angemeldet oder nicht, wie du willst."
		},
		page: {
			"title": "Mood Music",
			"subtitle": "Songs, die zu deiner Stimmung passen",
			"tab_listen": "Hören",
			"tab_moments": "Momente",
			"mood_label": "Wie fühlst du dich, oder welcher Song hat dich berührt?",
			"mood_placeholder": "Ein verregneter Abend, Heimweh – oder ein Songtitel",
			"find": "Songs finden",
			"finding": "Passende Songs werden gesucht…",
			"mood_chips": "Stimmungen",
			"mood_calm": "Ruhig",
			"mood_sad": "Traurig",
			"mood_happy": "Fröhlich",
			"mood_missing": "Sehnsucht",
			"mood_fired": "Voller Energie",
			"question_label": "Der DJ fragt",
			"answer_placeholder": "Deine Antwort",
			"send_answer": "Antworten",
			"empty_title": "Noch läuft nichts",
			"empty_body": "Sag, wie du dich fühlst, oder wähle oben eine Stimmung.",
			"now_playing": "Läuft gerade",
			"why": "Warum es passt",
			"like": "Gefällt mir",
			"liked": "Gefällt dir",
			"skip": "Überspringen",
			"more": "Mehr davon",
			"open_bilibili": "Auf bilibili öffnen",
			"bilibili_note": "Öffnet sich in einem neuen Tab deines eigenen Browsers.",
			"queue": "Als Nächstes",
			"play": "{{title}} abspielen",
			"player_title": "YouTube-Player: {{title}}",
			"pause_motion": "Hintergrundbewegung pausieren",
			"play_motion": "Hintergrundbewegung abspielen",
			"moments_empty_title": "Noch keine Momente",
			"moments_empty_body": "Jede Stimmung, die du teilst, bleibt hier – mit den Songs, die sie gebracht hat.",
			"error_generic": "Etwas ist schiefgelaufen ({{code}})",
			"error_unreadable": "Die Antwort des DJs ließ sich nicht lesen. Versuch es noch einmal.",
			"error_all_dropped": "Der DJ hat {{count}} Songs gefunden, aber keiner kam in einer Form zurück, die die Seite abspielen kann.",
			"retry": "Noch einmal fragen",
			"error_timeout": "Der DJ hat zu lange gebraucht. Versuch es noch einmal.",
			"approval_title": "Der DJ wartet auf dein OK für die Websuche",
			"approval_step_open": "Öffne den DJ-Chat mit dem Knopf unten.",
			"approval_step_trust": "Erlaube dort die Websuche. Wähle Vertrauen, dann fragt er nicht mehr.",
			"approval_step_back": "Komm hierher zurück. Deine Songs erscheinen von selbst.",
			"approval_open": "DJ-Chat öffnen",
			"dropped": "Ausgelassene Songs mit nicht abspielbarem Link: {{count}}",
			"source_youtube": "YouTube",
			"source_bilibili": "bilibili"
		}
	},
	en: {
		manifest: {
			"display_name": "Mood Music",
			"description": "Tell it how you feel, or name a song that moved you. A DJ agent finds songs with the same feeling and plays them: YouTube inside the page, bilibili in a new browser tab. Like or skip, and the next picks follow.",
			"page_label": "Mood Music",
			"highlight_1": "Say how you feel, or name a song that moved you — it finds more with the same feeling",
			"highlight_2": "Every pick says why it fits the mood",
			"highlight_3": "YouTube plays inside the page through the privacy-enhanced embed",
			"highlight_4": "bilibili songs open in a new tab of your own browser; the agent never touches your account",
			"highlight_5": "Like or skip a song, and the next picks use it",
			"highlight_6": "The background and motion follow the mood, in light and dark",
			"use_case_1": "Find and play songs that match how you feel right now, and keep a history of the moments that moved you.",
			"configuration_1": "No account is needed. YouTube plays in the page; bilibili opens in your own browser, signed in or not, as you choose."
		},
		page: {
			"title": "Mood Music",
			"subtitle": "Songs that fit how you feel right now",
			"tab_listen": "Listen",
			"tab_moments": "Moments",
			"mood_label": "How do you feel, or which song moved you?",
			"mood_placeholder": "A rainy evening, missing home — or a song title",
			"find": "Find songs",
			"finding": "Finding songs that fit…",
			"mood_chips": "Moods",
			"mood_calm": "Calm",
			"mood_sad": "Sad",
			"mood_happy": "Happy",
			"mood_missing": "Missing someone",
			"mood_fired": "Fired up",
			"question_label": "The DJ asks",
			"answer_placeholder": "Your answer",
			"send_answer": "Answer",
			"empty_title": "Nothing playing yet",
			"empty_body": "Say how you feel, or pick a mood above.",
			"now_playing": "Now playing",
			"why": "Why it fits",
			"like": "Like",
			"liked": "Liked",
			"skip": "Skip",
			"more": "More like this",
			"open_bilibili": "Open on bilibili",
			"bilibili_note": "Opens in a new tab of your own browser.",
			"queue": "Up next",
			"play": "Play {{title}}",
			"player_title": "YouTube player: {{title}}",
			"pause_motion": "Pause background motion",
			"play_motion": "Play background motion",
			"moments_empty_title": "No moments yet",
			"moments_empty_body": "Each mood you share is kept here, with the songs it brought.",
			"error_generic": "Something went wrong ({{code}})",
			"error_unreadable": "The DJ's answer could not be read. Try again.",
			"error_all_dropped": "The DJ found {{count}} songs, but none came back in a form the page can play.",
			"retry": "Ask again",
			"error_timeout": "The DJ took too long. Try again.",
			"approval_title": "The DJ is waiting for your OK to search the web",
			"approval_step_open": "Open the DJ chat with the button below.",
			"approval_step_trust": "Allow the web search there. Choose Trust so it stops asking.",
			"approval_step_back": "Come back here. Your songs show up on their own.",
			"approval_open": "Open the DJ chat",
			"dropped": "Songs left out because their link cannot play: {{count}}",
			"source_youtube": "YouTube",
			"source_bilibili": "bilibili"
		}
	},
	es: {
		manifest: {
			"display_name": "Mood Music",
			"description": "Dile cómo te sientes o nombra una canción que te emocionó. Un agente DJ busca canciones con el mismo sentimiento y las reproduce: YouTube dentro de la página y bilibili en una pestaña nueva del navegador. Con Me gusta u Omitir, las siguientes elecciones se ajustan.",
			"page_label": "Mood Music",
			"highlight_1": "Di cómo te sientes o nombra una canción que te emocionó: encuentra más con el mismo sentimiento",
			"highlight_2": "Cada elección explica por qué encaja con tu estado de ánimo",
			"highlight_3": "YouTube se reproduce en la página con la inserción de privacidad mejorada",
			"highlight_4": "Las canciones de bilibili se abren en una pestaña nueva de tu propio navegador; el agente nunca toca tu cuenta",
			"highlight_5": "Me gusta u Omitir se usan en las siguientes elecciones",
			"highlight_6": "El fondo y el movimiento siguen tu estado de ánimo, en claro y en oscuro",
			"use_case_1": "Encuentra y reproduce canciones que encajan con cómo te sientes ahora y guarda los momentos que te emocionaron.",
			"configuration_1": "No necesitas cuenta. YouTube se reproduce en la página; bilibili se abre en tu propio navegador, con sesión o sin ella, como prefieras."
		},
		page: {
			"title": "Mood Music",
			"subtitle": "Canciones para cómo te sientes ahora",
			"tab_listen": "Escuchar",
			"tab_moments": "Momentos",
			"mood_label": "¿Cómo te sientes, o qué canción te emocionó?",
			"mood_placeholder": "Una tarde de lluvia, echo de menos mi casa — o el título de una canción",
			"find": "Buscar canciones",
			"finding": "Buscando canciones que encajen…",
			"mood_chips": "Estados de ánimo",
			"mood_calm": "Tranquilo",
			"mood_sad": "Triste",
			"mood_happy": "Feliz",
			"mood_missing": "Echar de menos",
			"mood_fired": "Con energía",
			"question_label": "El DJ pregunta",
			"answer_placeholder": "Tu respuesta",
			"send_answer": "Responder",
			"empty_title": "Aún no suena nada",
			"empty_body": "Di cómo te sientes o elige un estado de ánimo arriba.",
			"now_playing": "Sonando ahora",
			"why": "Por qué encaja",
			"like": "Me gusta",
			"liked": "Te gusta",
			"skip": "Omitir",
			"more": "Más como esta",
			"open_bilibili": "Abrir en bilibili",
			"bilibili_note": "Se abre en una pestaña nueva de tu propio navegador.",
			"queue": "A continuación",
			"play": "Reproducir {{title}}",
			"player_title": "Reproductor de YouTube: {{title}}",
			"pause_motion": "Pausar el movimiento del fondo",
			"play_motion": "Reanudar el movimiento del fondo",
			"moments_empty_title": "Aún no hay momentos",
			"moments_empty_body": "Cada estado de ánimo que compartes queda aquí, con las canciones que trajo.",
			"error_generic": "Algo salió mal ({{code}})",
			"error_unreadable": "No se pudo leer la respuesta del DJ. Inténtalo de nuevo.",
			"error_all_dropped": "El DJ encontró {{count}} canciones, pero ninguna llegó en un formato que la página pueda reproducir.",
			"retry": "Preguntar otra vez",
			"error_timeout": "El DJ tardó demasiado. Inténtalo de nuevo.",
			"approval_title": "El DJ espera tu permiso para buscar en la web",
			"approval_step_open": "Abre el chat del DJ con el botón de abajo.",
			"approval_step_trust": "Permite allí la búsqueda web. Elige Confiar para que no vuelva a preguntar.",
			"approval_step_back": "Vuelve aquí. Tus canciones aparecerán solas.",
			"approval_open": "Abrir el chat del DJ",
			"dropped": "Canciones omitidas por un enlace que no se puede reproducir: {{count}}",
			"source_youtube": "YouTube",
			"source_bilibili": "bilibili"
		}
	},
	fr: {
		manifest: {
			"display_name": "Mood Music",
			"description": "Dis-lui ce que tu ressens, ou cite une chanson qui t’a ému. Un agent DJ trouve des chansons qui portent la même émotion et les joue : YouTube dans la page, bilibili dans un nouvel onglet du navigateur. J’aime ou Passer, et les choix suivants s’adaptent.",
			"page_label": "Mood Music",
			"highlight_1": "Dis ce que tu ressens, ou cite une chanson qui t’a ému : il en trouve d’autres avec la même émotion",
			"highlight_2": "Chaque choix dit pourquoi il correspond à ton humeur",
			"highlight_3": "YouTube se lit dans la page via l’intégration à confidentialité renforcée",
			"highlight_4": "Les chansons bilibili s’ouvrent dans un nouvel onglet de ton propre navigateur ; l’agent ne touche jamais ton compte",
			"highlight_5": "J’aime ou Passer sert aux choix suivants",
			"highlight_6": "Le fond et le mouvement suivent l’humeur, en clair comme en sombre",
			"use_case_1": "Trouver et écouter des chansons qui correspondent à ce que tu ressens maintenant, et garder les moments qui t’ont ému.",
			"configuration_1": "Aucun compte n’est nécessaire. YouTube se lit dans la page ; bilibili s’ouvre dans ton propre navigateur, connecté ou non, comme tu veux."
		},
		page: {
			"title": "Mood Music",
			"subtitle": "Des chansons pour ce que tu ressens maintenant",
			"tab_listen": "Écouter",
			"tab_moments": "Moments",
			"mood_label": "Que ressens-tu, ou quelle chanson t’a ému ?",
			"mood_placeholder": "Un soir de pluie, le mal du pays — ou un titre de chanson",
			"find": "Trouver des chansons",
			"finding": "Recherche de chansons qui conviennent…",
			"mood_chips": "Humeurs",
			"mood_calm": "Calme",
			"mood_sad": "Triste",
			"mood_happy": "Joyeux",
			"mood_missing": "Nostalgie",
			"mood_fired": "Plein d’énergie",
			"question_label": "Le DJ demande",
			"answer_placeholder": "Ta réponse",
			"send_answer": "Répondre",
			"empty_title": "Rien en lecture pour l’instant",
			"empty_body": "Dis ce que tu ressens, ou choisis une humeur ci-dessus.",
			"now_playing": "En lecture",
			"why": "Pourquoi ça colle",
			"like": "J’aime",
			"liked": "Aimé",
			"skip": "Passer",
			"more": "Plus dans ce genre",
			"open_bilibili": "Ouvrir sur bilibili",
			"bilibili_note": "S’ouvre dans un nouvel onglet de ton propre navigateur.",
			"queue": "À suivre",
			"play": "Lire {{title}}",
			"player_title": "Lecteur YouTube : {{title}}",
			"pause_motion": "Mettre en pause le mouvement du fond",
			"play_motion": "Relancer le mouvement du fond",
			"moments_empty_title": "Aucun moment pour l’instant",
			"moments_empty_body": "Chaque humeur que tu partages est gardée ici, avec les chansons qu’elle a apportées.",
			"error_generic": "Un problème est survenu ({{code}})",
			"error_unreadable": "Impossible de lire la réponse du DJ. Réessaie.",
			"error_all_dropped": "Le DJ a trouvé {{count}} chansons, mais aucune n'est revenue sous une forme que la page peut lire.",
			"retry": "Redemander",
			"error_timeout": "Le DJ a mis trop de temps. Réessaie.",
			"approval_title": "Le DJ attend ton accord pour chercher sur le web",
			"approval_step_open": "Ouvre le chat du DJ avec le bouton ci-dessous.",
			"approval_step_trust": "Autorise la recherche web. Choisis Faire confiance pour qu'il ne redemande plus.",
			"approval_step_back": "Reviens ici. Tes chansons apparaîtront toutes seules.",
			"approval_open": "Ouvrir le chat du DJ",
			"dropped": "Chansons écartées car leur lien est illisible : {{count}}",
			"source_youtube": "YouTube",
			"source_bilibili": "bilibili"
		}
	},
	hi: {
		manifest: {
			"display_name": "मूड म्यूज़िक",
			"description": "बताइए आप कैसा महसूस कर रहे हैं, या कोई गाना जिसने आपको छू लिया। DJ एजेंट उसी एहसास वाले गाने ढूँढकर चलाता है: YouTube पेज के अंदर, bilibili ब्राउज़र के नए टैब में। पसंद या छोड़ें दबाएँ, अगली पसंद उसी हिसाब से बदलेगी।",
			"page_label": "मूड म्यूज़िक",
			"highlight_1": "अपना मूड बताइए या कोई गाना जिसने आपको छुआ — यह उसी एहसास वाले और गाने ढूँढता है",
			"highlight_2": "हर गाने के साथ बताया जाता है कि यह इस मूड में क्यों जमता है",
			"highlight_3": "YouTube निजता-बढ़ाए गए एम्बेड से पेज के अंदर चलता है",
			"highlight_4": "bilibili के गाने आपके अपने ब्राउज़र के नए टैब में खुलते हैं; एजेंट कभी आपका खाता नहीं छूता",
			"highlight_5": "पसंद या छोड़ें अगली पसंद में काम आता है",
			"highlight_6": "पृष्ठभूमि और हलचल मूड के साथ बदलती है, लाइट और डार्क दोनों में",
			"use_case_1": "अभी के मूड से मेल खाते गाने ढूँढें और चलाएँ, और दिल छूने वाले पल सहेजें।",
			"configuration_1": "किसी खाते की ज़रूरत नहीं। YouTube पेज में चलता है; bilibili आपके अपने ब्राउज़र में खुलता है, साइन इन हो या नहीं, आपकी मर्ज़ी।"
		},
		page: {
			"title": "मूड म्यूज़िक",
			"subtitle": "अभी के मूड के गाने",
			"tab_listen": "सुनें",
			"tab_moments": "पल",
			"mood_label": "आप कैसा महसूस कर रहे हैं, या किस गाने ने आपको छुआ?",
			"mood_placeholder": "बारिश की शाम, घर की याद — या किसी गाने का नाम",
			"find": "गाने ढूँढें",
			"finding": "मेल खाते गाने ढूँढ रहे हैं…",
			"mood_chips": "मूड",
			"mood_calm": "शांत",
			"mood_sad": "उदास",
			"mood_happy": "खुश",
			"mood_missing": "याद",
			"mood_fired": "जोश",
			"question_label": "DJ पूछ रहा है",
			"answer_placeholder": "आपका जवाब",
			"send_answer": "जवाब दें",
			"empty_title": "अभी कुछ नहीं चल रहा",
			"empty_body": "अपना मूड बताइए, या ऊपर से कोई चुनें।",
			"now_playing": "अभी चल रहा है",
			"why": "क्यों जमता है",
			"like": "पसंद",
			"liked": "पसंद किया",
			"skip": "छोड़ें",
			"more": "ऐसे और",
			"open_bilibili": "bilibili पर खोलें",
			"bilibili_note": "आपके अपने ब्राउज़र के नए टैब में खुलता है।",
			"queue": "आगे",
			"play": "{{title}} चलाएँ",
			"player_title": "YouTube प्लेयर: {{title}}",
			"pause_motion": "पृष्ठभूमि की हलचल रोकें",
			"play_motion": "पृष्ठभूमि की हलचल चलाएँ",
			"moments_empty_title": "अभी कोई पल नहीं",
			"moments_empty_body": "आप जो भी मूड साझा करते हैं, वह यहाँ उसके गानों के साथ रहता है।",
			"error_generic": "कुछ गड़बड़ हो गई ({{code}})",
			"error_unreadable": "DJ का जवाब पढ़ा नहीं जा सका। फिर कोशिश करें।",
			"error_all_dropped": "DJ को {{count}} गाने मिले, पर कोई भी ऐसे रूप में नहीं आया जिसे पेज चला सके।",
			"retry": "फिर से पूछें",
			"error_timeout": "DJ ने बहुत देर लगाई। फिर कोशिश करें।",
			"approval_title": "DJ वेब खोज के लिए आपकी अनुमति का इंतज़ार कर रहा है",
			"approval_step_open": "नीचे दिए बटन से DJ की चैट खोलें।",
			"approval_step_trust": "वहाँ वेब खोज की अनुमति दें। भरोसा चुनें ताकि वह फिर न पूछे।",
			"approval_step_back": "यहाँ लौट आएँ। आपके गाने अपने-आप दिखेंगे।",
			"approval_open": "DJ की चैट खोलें",
			"dropped": "जिन गानों का लिंक नहीं चल सकता, वे छोड़े गए: {{count}}",
			"source_youtube": "YouTube",
			"source_bilibili": "bilibili"
		}
	},
	it: {
		manifest: {
			"display_name": "Mood Music",
			"description": "Digli come ti senti o nomina una canzone che ti ha emozionato. Un agente DJ trova canzoni con la stessa emozione e le riproduce: YouTube nella pagina, bilibili in una nuova scheda del browser. Con Mi piace o Salta le scelte successive si adattano.",
			"page_label": "Mood Music",
			"highlight_1": "Di’ come ti senti o nomina una canzone che ti ha emozionato: ne trova altre con la stessa emozione",
			"highlight_2": "Ogni scelta spiega perché si adatta al tuo umore",
			"highlight_3": "YouTube si riproduce nella pagina con l’incorporamento a privacy avanzata",
			"highlight_4": "Le canzoni di bilibili si aprono in una nuova scheda del tuo browser; l’agente non tocca mai il tuo account",
			"highlight_5": "Mi piace o Salta vengono usati per le scelte successive",
			"highlight_6": "Lo sfondo e il movimento seguono l’umore, in chiaro e in scuro",
			"use_case_1": "Trova e riproduci canzoni adatte a come ti senti ora e conserva i momenti che ti hanno emozionato.",
			"configuration_1": "Non serve un account. YouTube si riproduce nella pagina; bilibili si apre nel tuo browser, con o senza accesso, come preferisci."
		},
		page: {
			"title": "Mood Music",
			"subtitle": "Canzoni per come ti senti ora",
			"tab_listen": "Ascolta",
			"tab_moments": "Momenti",
			"mood_label": "Come ti senti, o quale canzone ti ha emozionato?",
			"mood_placeholder": "Una sera di pioggia, nostalgia di casa — o il titolo di una canzone",
			"find": "Trova canzoni",
			"finding": "Cerco canzoni adatte…",
			"mood_chips": "Umori",
			"mood_calm": "Calmo",
			"mood_sad": "Triste",
			"mood_happy": "Felice",
			"mood_missing": "Nostalgia",
			"mood_fired": "Carico",
			"question_label": "Il DJ chiede",
			"answer_placeholder": "La tua risposta",
			"send_answer": "Rispondi",
			"empty_title": "Ancora niente in riproduzione",
			"empty_body": "Di’ come ti senti o scegli un umore qui sopra.",
			"now_playing": "In riproduzione",
			"why": "Perché si adatta",
			"like": "Mi piace",
			"liked": "Ti piace",
			"skip": "Salta",
			"more": "Altre così",
			"open_bilibili": "Apri su bilibili",
			"bilibili_note": "Si apre in una nuova scheda del tuo browser.",
			"queue": "Prossimi",
			"play": "Riproduci {{title}}",
			"player_title": "Player YouTube: {{title}}",
			"pause_motion": "Metti in pausa il movimento dello sfondo",
			"play_motion": "Riprendi il movimento dello sfondo",
			"moments_empty_title": "Ancora nessun momento",
			"moments_empty_body": "Ogni umore che condividi resta qui, con le canzoni che ha portato.",
			"error_generic": "Qualcosa è andato storto ({{code}})",
			"error_unreadable": "Impossibile leggere la risposta del DJ. Riprova.",
			"error_all_dropped": "Il DJ ha trovato {{count}} canzoni, ma nessuna è tornata in una forma che la pagina può riprodurre.",
			"retry": "Chiedi di nuovo",
			"error_timeout": "Il DJ ci ha messo troppo. Riprova.",
			"approval_title": "Il DJ aspetta il tuo ok per cercare sul web",
			"approval_step_open": "Apri la chat del DJ con il pulsante qui sotto.",
			"approval_step_trust": "Consenti lì la ricerca web. Scegli Fidati così non chiede più.",
			"approval_step_back": "Torna qui. Le canzoni compariranno da sole.",
			"approval_open": "Apri la chat del DJ",
			"dropped": "Canzoni escluse per un link non riproducibile: {{count}}",
			"source_youtube": "YouTube",
			"source_bilibili": "bilibili"
		}
	},
	ja: {
		manifest: {
			"display_name": "ムードミュージック",
			"description": "今の気持ちや、心を動かされた曲を伝えてください。DJ エージェントが同じ気分の曲を探して再生します。YouTube はページ内で、bilibili はブラウザの新しいタブで開きます。いいね・スキップすると次の選曲に反映されます。",
			"page_label": "ムードミュージック",
			"highlight_1": "気持ちや心に響いた曲を伝えると、同じ気分の曲をもっと探します",
			"highlight_2": "どの曲にも、その気分に合う理由が添えられます",
			"highlight_3": "YouTube はプライバシー強化モードの埋め込みでページ内再生",
			"highlight_4": "bilibili の曲はご自身のブラウザの新しいタブで開き、エージェントがアカウントに触れることはありません",
			"highlight_5": "いいね・スキップが次の選曲に使われます",
			"highlight_6": "背景と動きが気分に合わせて変わります（ライト・ダーク対応）",
			"use_case_1": "今の気持ちに合う曲を探して再生し、心に残った瞬間を記録します。",
			"configuration_1": "アカウントは不要です。YouTube はページ内で再生、bilibili はご自身のブラウザで開きます（ログインは任意）。"
		},
		page: {
			"title": "ムードミュージック",
			"subtitle": "今の気持ちに合う曲",
			"tab_listen": "聴く",
			"tab_moments": "モーメント",
			"mood_label": "今どんな気持ち？心に響いた曲は？",
			"mood_placeholder": "雨の夕方、家が恋しい——または曲名",
			"find": "曲を探す",
			"finding": "合う曲を探しています…",
			"mood_chips": "気分",
			"mood_calm": "穏やか",
			"mood_sad": "悲しい",
			"mood_happy": "うれしい",
			"mood_missing": "恋しい",
			"mood_fired": "燃える",
			"question_label": "DJ からの質問",
			"answer_placeholder": "あなたの答え",
			"send_answer": "答える",
			"empty_title": "まだ何も再生していません",
			"empty_body": "気持ちを伝えるか、上の気分を選んでください。",
			"now_playing": "再生中",
			"why": "合う理由",
			"like": "いいね",
			"liked": "いいね済み",
			"skip": "スキップ",
			"more": "似た曲をもっと",
			"open_bilibili": "bilibili で開く",
			"bilibili_note": "ご自身のブラウザの新しいタブで開きます。",
			"queue": "次の曲",
			"play": "{{title}} を再生",
			"player_title": "YouTube プレーヤー：{{title}}",
			"pause_motion": "背景の動きを一時停止",
			"play_motion": "背景の動きを再生",
			"moments_empty_title": "まだモーメントはありません",
			"moments_empty_body": "共有した気持ちが、届いた曲と一緒にここに残ります。",
			"error_generic": "問題が発生しました（{{code}}）",
			"error_unreadable": "DJ の返答を読み取れませんでした。もう一度お試しください。",
			"error_all_dropped": "DJ は {{count}} 曲見つけましたが、ページで再生できる形で返ってきた曲はありませんでした。",
			"retry": "もう一度聞く",
			"error_timeout": "DJ の応答に時間がかかりすぎました。もう一度お試しください。",
			"approval_title": "DJ がウェブ検索の許可を待っています",
			"approval_step_open": "下のボタンで DJ のチャットを開きます。",
			"approval_step_trust": "そこでウェブ検索を許可します。「信頼」を選ぶと次から聞かれません。",
			"approval_step_back": "ここに戻ると、曲が自動で表示されます。",
			"approval_open": "DJ のチャットを開く",
			"dropped": "再生できないリンクのため除外した曲：{{count}}",
			"source_youtube": "YouTube",
			"source_bilibili": "bilibili"
		}
	},
	ko: {
		manifest: {
			"display_name": "무드 뮤직",
			"description": "지금 기분이나 마음을 울린 노래를 알려 주세요. DJ 에이전트가 같은 느낌의 노래를 찾아 재생합니다. YouTube는 페이지 안에서, bilibili는 브라우저 새 탭에서 열립니다. 좋아요나 건너뛰기를 누르면 다음 추천에 반영됩니다.",
			"page_label": "무드 뮤직",
			"highlight_1": "기분이나 마음을 울린 노래를 말하면 같은 느낌의 노래를 더 찾아 줍니다",
			"highlight_2": "추천곡마다 이 기분에 맞는 이유를 알려 줍니다",
			"highlight_3": "YouTube는 개인정보 보호 강화 임베드로 페이지 안에서 재생됩니다",
			"highlight_4": "bilibili 노래는 내 브라우저의 새 탭에서 열리며, 에이전트는 계정에 손대지 않습니다",
			"highlight_5": "좋아요나 건너뛰기가 다음 추천에 쓰입니다",
			"highlight_6": "배경과 움직임이 기분에 따라 바뀌며 라이트·다크 모두 지원합니다",
			"use_case_1": "지금 기분에 맞는 노래를 찾아 재생하고, 마음을 울린 순간을 기록합니다.",
			"configuration_1": "계정이 필요 없습니다. YouTube는 페이지에서 재생되고, bilibili는 내 브라우저에서 열립니다(로그인은 선택)."
		},
		page: {
			"title": "무드 뮤직",
			"subtitle": "지금 기분에 맞는 노래",
			"tab_listen": "듣기",
			"tab_moments": "순간",
			"mood_label": "지금 기분은 어때요? 어떤 노래가 마음을 울렸나요?",
			"mood_placeholder": "비 오는 저녁, 집이 그리워요 — 또는 노래 제목",
			"find": "노래 찾기",
			"finding": "어울리는 노래를 찾는 중…",
			"mood_chips": "기분",
			"mood_calm": "평온",
			"mood_sad": "슬픔",
			"mood_happy": "행복",
			"mood_missing": "그리움",
			"mood_fired": "열정",
			"question_label": "DJ의 질문",
			"answer_placeholder": "내 대답",
			"send_answer": "대답하기",
			"empty_title": "아직 재생 중인 곡이 없습니다",
			"empty_body": "기분을 말하거나 위에서 하나를 고르세요.",
			"now_playing": "재생 중",
			"why": "어울리는 이유",
			"like": "좋아요",
			"liked": "좋아요 함",
			"skip": "건너뛰기",
			"more": "비슷한 곡 더 보기",
			"open_bilibili": "bilibili에서 열기",
			"bilibili_note": "내 브라우저의 새 탭에서 열립니다.",
			"queue": "다음 곡",
			"play": "{{title}} 재생",
			"player_title": "YouTube 플레이어: {{title}}",
			"pause_motion": "배경 움직임 일시정지",
			"play_motion": "배경 움직임 재생",
			"moments_empty_title": "아직 순간이 없습니다",
			"moments_empty_body": "공유한 기분이 그때 들은 노래와 함께 여기에 남습니다.",
			"error_generic": "문제가 발생했습니다({{code}})",
			"error_unreadable": "DJ의 답을 읽을 수 없습니다. 다시 시도하세요.",
			"error_all_dropped": "DJ가 노래 {{count}}곡을 찾았지만, 페이지에서 재생할 수 있는 형태로 온 곡이 없어요.",
			"retry": "다시 물어보기",
			"error_timeout": "DJ 응답이 너무 오래 걸렸습니다. 다시 시도하세요.",
			"approval_title": "DJ가 웹 검색 허락을 기다리고 있어요",
			"approval_step_open": "아래 버튼으로 DJ 채팅을 여세요.",
			"approval_step_trust": "거기서 웹 검색을 허용하세요. '신뢰'를 고르면 다시 묻지 않아요.",
			"approval_step_back": "여기로 돌아오면 노래가 저절로 나타나요.",
			"approval_open": "DJ 채팅 열기",
			"dropped": "재생할 수 없는 링크라 제외한 곡: {{count}}",
			"source_youtube": "YouTube",
			"source_bilibili": "bilibili"
		}
	},
	pt: {
		manifest: {
			"display_name": "Mood Music",
			"description": "Diga como você se sente ou cite uma música que te emocionou. Um agente DJ encontra músicas com o mesmo sentimento e as toca: YouTube dentro da página e bilibili em uma nova aba do navegador. Curtir ou Pular ajusta as próximas escolhas.",
			"page_label": "Mood Music",
			"highlight_1": "Diga como você se sente ou cite uma música que te emocionou — ele encontra mais com o mesmo sentimento",
			"highlight_2": "Cada escolha diz por que combina com o seu humor",
			"highlight_3": "O YouTube toca na página pela incorporação com privacidade aprimorada",
			"highlight_4": "As músicas do bilibili abrem em uma nova aba do seu próprio navegador; o agente nunca mexe na sua conta",
			"highlight_5": "Curtir ou Pular é usado nas próximas escolhas",
			"highlight_6": "O fundo e o movimento acompanham o humor, no claro e no escuro",
			"use_case_1": "Encontre e toque músicas que combinam com como você se sente agora e guarde os momentos que te emocionaram.",
			"configuration_1": "Não precisa de conta. O YouTube toca na página; o bilibili abre no seu próprio navegador, com ou sem login, como preferir."
		},
		page: {
			"title": "Mood Music",
			"subtitle": "Músicas para como você se sente agora",
			"tab_listen": "Ouvir",
			"tab_moments": "Momentos",
			"mood_label": "Como você se sente, ou qual música te emocionou?",
			"mood_placeholder": "Uma noite de chuva, saudade de casa — ou o nome de uma música",
			"find": "Encontrar músicas",
			"finding": "Procurando músicas que combinem…",
			"mood_chips": "Humores",
			"mood_calm": "Calmo",
			"mood_sad": "Triste",
			"mood_happy": "Feliz",
			"mood_missing": "Saudade",
			"mood_fired": "Empolgado",
			"question_label": "O DJ pergunta",
			"answer_placeholder": "Sua resposta",
			"send_answer": "Responder",
			"empty_title": "Nada tocando ainda",
			"empty_body": "Diga como você se sente ou escolha um humor acima.",
			"now_playing": "Tocando agora",
			"why": "Por que combina",
			"like": "Curtir",
			"liked": "Curtida",
			"skip": "Pular",
			"more": "Mais como esta",
			"open_bilibili": "Abrir no bilibili",
			"bilibili_note": "Abre em uma nova aba do seu próprio navegador.",
			"queue": "A seguir",
			"play": "Tocar {{title}}",
			"player_title": "Player do YouTube: {{title}}",
			"pause_motion": "Pausar o movimento do fundo",
			"play_motion": "Retomar o movimento do fundo",
			"moments_empty_title": "Ainda não há momentos",
			"moments_empty_body": "Cada humor que você compartilha fica aqui, com as músicas que trouxe.",
			"error_generic": "Algo deu errado ({{code}})",
			"error_unreadable": "Não foi possível ler a resposta do DJ. Tente de novo.",
			"error_all_dropped": "O DJ achou {{count}} músicas, mas nenhuma voltou num formato que a página consiga tocar.",
			"retry": "Perguntar de novo",
			"error_timeout": "O DJ demorou demais. Tente de novo.",
			"approval_title": "O DJ está esperando seu ok para pesquisar na web",
			"approval_step_open": "Abra o chat do DJ no botão abaixo.",
			"approval_step_trust": "Permita a pesquisa na web lá. Escolha Confiar para ele não perguntar de novo.",
			"approval_step_back": "Volte aqui. Suas músicas aparecem sozinhas.",
			"approval_open": "Abrir o chat do DJ",
			"dropped": "Músicas deixadas de fora por link que não toca: {{count}}",
			"source_youtube": "YouTube",
			"source_bilibili": "bilibili"
		}
	},
	ru: {
		manifest: {
			"display_name": "Музыка настроения",
			"description": "Расскажите, что вы чувствуете, или назовите песню, которая вас тронула. DJ-агент найдёт песни с тем же настроением и включит их: YouTube прямо на странице, bilibili в новой вкладке браузера. Отмечайте «Нравится» или «Пропустить» — следующие подборки это учтут.",
			"page_label": "Музыка настроения",
			"highlight_1": "Расскажите о настроении или назовите песню, которая тронула, — он найдёт ещё с тем же чувством",
			"highlight_2": "К каждой песне — пояснение, почему она подходит настроению",
			"highlight_3": "YouTube играет на странице через встраивание с усиленной конфиденциальностью",
			"highlight_4": "Песни bilibili открываются в новой вкладке вашего браузера; агент никогда не трогает ваш аккаунт",
			"highlight_5": "«Нравится» и «Пропустить» учитываются в следующих подборках",
			"highlight_6": "Фон и движение меняются с настроением, в светлой и тёмной теме",
			"use_case_1": "Находите и слушайте песни под ваше настроение и сохраняйте моменты, которые вас тронули.",
			"configuration_1": "Аккаунт не нужен. YouTube играет на странице; bilibili открывается в вашем браузере — со входом или без, как захотите."
		},
		page: {
			"title": "Музыка настроения",
			"subtitle": "Песни под ваше настроение",
			"tab_listen": "Слушать",
			"tab_moments": "Моменты",
			"mood_label": "Что вы чувствуете, или какая песня вас тронула?",
			"mood_placeholder": "Дождливый вечер, скучаю по дому — или название песни",
			"find": "Найти песни",
			"finding": "Ищу подходящие песни…",
			"mood_chips": "Настроения",
			"mood_calm": "Спокойно",
			"mood_sad": "Грустно",
			"mood_happy": "Радостно",
			"mood_missing": "Скучаю",
			"mood_fired": "Драйв",
			"question_label": "DJ спрашивает",
			"answer_placeholder": "Ваш ответ",
			"send_answer": "Ответить",
			"empty_title": "Пока ничего не играет",
			"empty_body": "Расскажите о настроении или выберите его выше.",
			"now_playing": "Сейчас играет",
			"why": "Почему подходит",
			"like": "Нравится",
			"liked": "Понравилось",
			"skip": "Пропустить",
			"more": "Ещё похожих",
			"open_bilibili": "Открыть на bilibili",
			"bilibili_note": "Откроется в новой вкладке вашего браузера.",
			"queue": "Дальше",
			"play": "Включить {{title}}",
			"player_title": "Плеер YouTube: {{title}}",
			"pause_motion": "Приостановить движение фона",
			"play_motion": "Возобновить движение фона",
			"moments_empty_title": "Пока нет моментов",
			"moments_empty_body": "Каждое настроение, которым вы делитесь, остаётся здесь вместе с песнями.",
			"error_generic": "Что-то пошло не так ({{code}})",
			"error_unreadable": "Не удалось прочитать ответ DJ. Попробуйте ещё раз.",
			"error_all_dropped": "DJ нашёл песен: {{count}}, но ни одна не пришла в виде, который страница может воспроизвести.",
			"retry": "Спросить ещё раз",
			"error_timeout": "DJ отвечал слишком долго. Попробуйте ещё раз.",
			"approval_title": "DJ ждёт вашего разрешения на поиск в интернете",
			"approval_step_open": "Откройте чат DJ кнопкой ниже.",
			"approval_step_trust": "Разрешите там веб-поиск. Выберите «Доверять», чтобы он больше не спрашивал.",
			"approval_step_back": "Вернитесь сюда. Песни появятся сами.",
			"approval_open": "Открыть чат DJ",
			"dropped": "Пропущено песен со ссылкой, которую нельзя воспроизвести: {{count}}",
			"source_youtube": "YouTube",
			"source_bilibili": "bilibili"
		}
	},
	"zh-CN": {
		manifest: {
			"display_name": "情绪音乐",
			"description": "说说你的心情，或说出一首打动你的歌。DJ 助手会找来感觉相同的歌并播放：YouTube 在页面里播放，bilibili 在浏览器新标签页打开。点喜欢或跳过，下次推荐会跟着变。",
			"page_label": "情绪音乐",
			"highlight_1": "说出心情，或说出一首打动你的歌，它会找来更多感觉相同的歌",
			"highlight_2": "每首歌都会说明为什么适合这份心情",
			"highlight_3": "YouTube 通过隐私增强的嵌入方式在页面里播放",
			"highlight_4": "bilibili 的歌在你自己浏览器的新标签页打开，助手从不碰你的账号",
			"highlight_5": "喜欢或跳过一首歌，下次推荐会用上",
			"highlight_6": "背景和动效随心情变化，亮色暗色都适用",
			"use_case_1": "找到并播放符合你此刻心情的歌，并记下打动你的那些时刻。",
			"configuration_1": "不需要账号。YouTube 在页面里播放；bilibili 在你自己的浏览器打开，登录与否由你决定。"
		},
		page: {
			"title": "情绪音乐",
			"subtitle": "贴合你此刻心情的歌",
			"tab_listen": "聆听",
			"tab_moments": "时刻",
			"mood_label": "你现在的心情如何，或哪首歌打动了你？",
			"mood_placeholder": "下雨的傍晚，想家了——或者一首歌名",
			"find": "找歌",
			"finding": "正在找合适的歌…",
			"mood_chips": "心情",
			"mood_calm": "平静",
			"mood_sad": "难过",
			"mood_happy": "开心",
			"mood_missing": "想念",
			"mood_fired": "燃",
			"question_label": "DJ 想问",
			"answer_placeholder": "你的回答",
			"send_answer": "回答",
			"empty_title": "还没有在播放",
			"empty_body": "说说你的心情，或在上面选一个。",
			"now_playing": "正在播放",
			"why": "为什么适合",
			"like": "喜欢",
			"liked": "已喜欢",
			"skip": "跳过",
			"more": "更多类似的",
			"open_bilibili": "在 bilibili 打开",
			"bilibili_note": "在你自己浏览器的新标签页打开。",
			"queue": "接下来",
			"play": "播放 {{title}}",
			"player_title": "YouTube 播放器：{{title}}",
			"pause_motion": "暂停背景动效",
			"play_motion": "播放背景动效",
			"moments_empty_title": "还没有时刻",
			"moments_empty_body": "你分享的每份心情都会留在这里，连同它带来的歌。",
			"error_generic": "出了点问题（{{code}}）",
			"error_unreadable": "读不懂 DJ 的回答，请再试一次。",
			"error_all_dropped": "DJ 找到了 {{count}} 首歌，但回的格式不对或链接不能播，一首也没放进来。",
			"retry": "再问一次",
			"error_timeout": "DJ 太久没回应，请再试一次。",
			"approval_title": "DJ 在等你允许它上网搜索",
			"approval_step_open": "点下面的按钮，打开 DJ 的对话。",
			"approval_step_trust": "在那里允许网页搜索。选「信任」，以后就不再问。",
			"approval_step_back": "回到这里，歌会自己出现。",
			"approval_open": "打开 DJ 对话",
			"dropped": "有 {{count}} 首歌的链接无法播放，已略过。",
			"source_youtube": "YouTube",
			"source_bilibili": "bilibili"
		}
	}
};
var own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
function lookup(catalog, key) {
	let node = catalog;
	for (const part of key.split(".")) {
		if (node === void 0 || typeof node === "string" || !own(node, part)) return void 0;
		node = node[part];
	}
	return typeof node === "string" ? node : void 0;
}
/** The catalogs to try for `locale`, most specific first, always ending in English. */
function localeChain(locale) {
	const chain = [];
	const add = (candidate) => {
		if (own(CATALOGS, candidate) && !chain.includes(candidate)) chain.push(candidate);
	};
	add(locale);
	add(locale.split("-")[0]);
	add("en");
	return chain;
}
function currentLocale() {
	try {
		const locale = activeLocale();
		return typeof locale === "string" && locale ? locale : "en";
	} catch {
		return "en";
	}
}
var PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;
function t(key, vars) {
	for (const locale of localeChain(currentLocale())) {
		const text = lookup(CATALOGS[locale], key);
		if (text !== void 0) return text.replace(PLACEHOLDER, (whole, name) => vars && own(vars, name) ? String(vars[name]) : whole);
	}
	return key;
}
// src/api.ts
var BASE = "/api/apps/mood-music";
var DJ_AGENT = "mood-music-dj";
var SLOT_NAME = "mood-music";
var MEMORY_MODE = "temporary";
function createMoodApi(api) {
	const openSlot = () => api.post("/api/chat/slots", {
		name: SLOT_NAME,
		agent: DJ_AGENT,
		memory_mode: MEMORY_MODE
	});
	return {
		state: () => api.get(`${BASE}/state`),
		addMoment: (mood) => api.post(`${BASE}/moments`, { mood }),
		setQueue: (body) => api.post(`${BASE}/queue`, body),
		feedback: (pickId, verdict) => api.put(`${BASE}/queue/${encodeURIComponent(pickId)}/feedback`, { verdict }),
		openSlot,
		getSlot: (key) => api.get(`/api/chat/slots/${encodeURIComponent(key)}`),
		/** Send one turn; a refusal rejects. Returns the slot key the turn went to. */
		ask: async (message) => {
			const { key } = await openSlot();
			const receipt = await api.post("/api/chat?ws=1", {
				message,
				slot: key,
				agent: DJ_AGENT,
				memory_mode: MEMORY_MODE
			});
			if (receipt && receipt.ok === false) throw new Error(receipt.error || "send_refused");
			return key;
		}
	};
}
/** The newest assistant reply in a slot, or ''. */
function latestReply(slot) {
	const msgs = slot?.messages ?? [];
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i];
		if (m.role === "assistant" && typeof m.content === "string" && m.content.trim()) return m.content;
	}
	return "";
}
/**
* Whether the DJ's turn is parked on a tool approval: an unanswered `permission`
* row after the newest user message. The row is the one the chat's approval card
* reads; the page cannot answer it, so it sends the person to that chat.
*/
function awaitingApproval(slot) {
	const msgs = slot?.messages ?? [];
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i];
		if (m.role === "user") return false;
		if (m.role === "permission" && m.meta?.approval_id && !m.meta.resolved) return true;
	}
	return false;
}
// src/cardStyle.ts
/** A translucent card over the mood backdrop. Inline, because the host
*  stylesheet carries only the classes its own source uses. */
var CARD_STYLE = {
	background: "color-mix(in oklab, var(--card) 82%, transparent)",
	backdropFilter: "blur(12px)"
};
// src/MomentsTab.tsx
/** The Moments tab: each mood the person shared, newest first, with its songs. */
function MomentsTab({ moments }) {
	if (moments.length === 0) return /* @__PURE__ */ jsx(EmptyState, {
		icon: /* @__PURE__ */ jsx(Music, { size: 28 }),
		title: t("page.moments_empty_title"),
		subtitle: t("page.moments_empty_body")
	});
	return /* @__PURE__ */ jsx("ul", {
		className: "flex flex-col gap-2",
		"data-testid": "mood-moments",
		children: moments.map((m) => /* @__PURE__ */ jsxs("li", {
			className: "rounded-xl border border-[var(--border)] p-3",
			style: CARD_STYLE,
			children: [
				/* @__PURE__ */ jsxs("div", {
					className: "flex items-baseline justify-between gap-3",
					children: [/* @__PURE__ */ jsx("p", {
						className: "text-sm font-semibold text-[var(--text)]",
						children: m.mood
					}), /* @__PURE__ */ jsx("time", {
						className: "shrink-0 text-xs text-[var(--muted)]",
						dateTime: (/* @__PURE__ */ new Date(m.at * 1e3)).toISOString(),
						children: fmtDateTime(m.at * 1e3)
					})]
				}),
				m.note && /* @__PURE__ */ jsx("p", {
					className: "mt-1 text-sm text-[var(--text)]",
					children: m.note
				}),
				m.tags.length > 0 && /* @__PURE__ */ jsx("p", {
					className: "mt-1 text-xs text-[var(--muted)]",
					children: m.tags.join(" · ")
				}),
				m.songs.length > 0 && /* @__PURE__ */ jsx("ol", {
					className: "mt-2 list-decimal pl-5 text-xs text-[var(--muted)]",
					children: m.songs.map((s, i) => /* @__PURE__ */ jsx("li", { children: s.artist ? `${s.title} — ${s.artist}` : s.title }, i))
				})
			]
		}, m.id))
	});
}
// src/moods.ts
/**
* The mood chips, and how each mood colours and moves the page's backdrop.
*
* A mood names two hues and a drift period. The backdrop never paints a hue
* straight: it mixes each one into the theme's own `--bg` (`MoodBackdrop`), so
* the same mood reads soft on a light theme and deep on a dark one, and text
* keeps the theme's `--text` contrast.
*/
var MOOD_KEYS = [
	"calm",
	"sad",
	"happy",
	"missing",
	"fired"
];
var THEMES = {
	calm: {
		hues: [195, 165],
		driftSeconds: 30,
		strength: 22
	},
	sad: {
		hues: [220, 255],
		driftSeconds: 36,
		strength: 20
	},
	happy: {
		hues: [42, 330],
		driftSeconds: 16,
		strength: 26
	},
	missing: {
		hues: [280, 320],
		driftSeconds: 26,
		strength: 22
	},
	fired: {
		hues: [8, 32],
		driftSeconds: 10,
		strength: 30
	},
	neutral: {
		hues: [230, 300],
		driftSeconds: 24,
		strength: 16
	}
};
function isMoodKey(value) {
	return typeof value === "string" && MOOD_KEYS.includes(value);
}
/** The look for a chip key; anything else (an unknown chip, free text) is neutral. */
function moodTheme(look) {
	return isMoodKey(look) ? THEMES[look] : THEMES.neutral;
}
/** Words that place free text, or the agent's mood tags, on one of the chips. */
var WORDS = {
	calm: [
		"平静",
		"安静",
		"放松",
		"calm",
		"peaceful",
		"relaxed",
		"chill"
	],
	sad: [
		"难过",
		"伤心",
		"悲伤",
		"失落",
		"sad",
		"down",
		"heartbroken",
		"blue"
	],
	happy: [
		"开心",
		"快乐",
		"高兴",
		"愉快",
		"happy",
		"joy",
		"cheerful"
	],
	missing: [
		"想念",
		"思念",
		"怀念",
		"miss",
		"missing",
		"nostalgic",
		"longing"
	],
	fired: [
		"燃",
		"热血",
		"激动",
		"兴奋",
		"hype",
		"pumped",
		"energetic"
	]
};
/** The chip a mood text or tag list reads as, or neutral when none fits. */
function moodLookFor(texts) {
	const hay = texts.join(" ").toLowerCase();
	if (!hay.trim()) return "neutral";
	for (const key of MOOD_KEYS) if (WORDS[key].some((w) => hay.includes(w))) return key;
	return "neutral";
}
// src/MoodBackdrop.tsx
var KEYFRAMES = `
@keyframes mood-music-drift-a { 0%,100% { transform: translate(0,0) } 50% { transform: translate(60px,40px) } }
@keyframes mood-music-drift-b { 0%,100% { transform: translate(0,0) } 50% { transform: translate(-50px,-30px) } }
`;
function MoodBackdrop({ look, moving }) {
	const theme = moodTheme(look);
	const glow = (index, place) => ({
		position: "absolute",
		borderRadius: "9999px",
		filter: "blur(64px)",
		background: `radial-gradient(closest-side, color-mix(in oklab, hsl(${theme.hues[index]} 85% 60%) ${theme.strength}%, var(--bg)), transparent)`,
		transition: moving ? "background 1s ease" : void 0,
		animation: moving ? `mood-music-drift-${index ? "b" : "a"} ${theme.driftSeconds}s ease-in-out infinite` : "none",
		...place
	});
	return /* @__PURE__ */ jsxs("div", {
		"aria-hidden": "true",
		"data-testid": "mood-backdrop",
		"data-look": look,
		"data-moving": moving ? "true" : "false",
		style: {
			position: "absolute",
			inset: 0,
			overflow: "hidden",
			pointerEvents: "none",
			background: "var(--bg)"
		},
		children: [
			/* @__PURE__ */ jsx("style", { children: KEYFRAMES }),
			/* @__PURE__ */ jsx("div", {
				"data-testid": "mood-glow",
				"data-hue": theme.hues[0],
				style: glow(0, {
					left: "-15%",
					top: "-20%",
					width: "70%",
					height: "75%"
				})
			}),
			/* @__PURE__ */ jsx("div", {
				"data-testid": "mood-glow",
				"data-hue": theme.hues[1],
				style: glow(1, {
					right: "-10%",
					bottom: "-25%",
					width: "65%",
					height: "80%"
				})
			})
		]
	});
}
// src/links.ts
/**
* The two song links Mood Music plays, and nothing else.
*
* Mirrors `src/kiro_crew/apps/builtins/mood_music/backend/links.py`: the page
* drops a pick the backend would refuse, so one bad link from the agent loses
* only that song. A YouTube pick keeps only its 11-character video id, and the
* embed URL is built here on the one host the dashboard CSP frames. A bilibili
* pick must be https on an exact bilibili host.
*/
var VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
var BILIBILI_HOSTS = /* @__PURE__ */ new Set([
	"www.bilibili.com",
	"m.bilibili.com",
	"b23.tv"
]);
var YOUTUBE_WATCH_HOSTS = /* @__PURE__ */ new Set([
	"www.youtube.com",
	"youtube.com",
	"m.youtube.com",
	"music.youtube.com"
]);
var MAX_URL = 2048;
/** The embed origin and path the dashboard CSP `frame-src` admits. */
var YOUTUBE_EMBED_BASE = "https://www.youtube-nocookie.com/embed/";
function validVideoId(value) {
	return typeof value === "string" && VIDEO_ID_RE.test(value) ? value : null;
}
/** A plain https URL: no user info, no port, no character a browser reads differently. */
function parseHttps(raw) {
	if (typeof raw !== "string" || raw.length > MAX_URL) return null;
	if (/[\\\u0000-\u0020\u007f]/.test(raw)) return null;
	let url;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
	return url;
}
/** The video id a YouTube watch or share link names, or null. */
function youtubeVideoId(raw) {
	const url = parseHttps(raw);
	if (!url) return null;
	if (url.hostname === "youtu.be") return validVideoId(url.pathname.slice(1));
	if (YOUTUBE_WATCH_HOSTS.has(url.hostname) && url.pathname === "/watch") {
		const ids = url.searchParams.getAll("v");
		return ids.length === 1 ? validVideoId(ids[0]) : null;
	}
	return null;
}
/** The link rebuilt from its parts when it is an https bilibili link, else null. */
function bilibiliUrl(raw) {
	const url = parseHttps(raw);
	if (!url || !BILIBILI_HOSTS.has(url.hostname)) return null;
	return `https://${url.hostname}${url.pathname}${url.search}`;
}
/** The privacy-enhanced embed URL for a checked id; null for anything else. */
function youtubeEmbedUrl(videoId, autoplay) {
	const id = validVideoId(videoId);
	if (!id) return null;
	return `${YOUTUBE_EMBED_BASE}${id}?rel=0${autoplay ? "&autoplay=1" : ""}`;
}
// src/NowPlaying.tsx
/**
* The now-playing card: the player, the song, why it fits, and like / skip.
*
* A YouTube pick plays in a sandboxed iframe on the privacy-enhanced embed host
* (the origin `app.json` declares in `ui.frameSources`), its URL built from the
* checked video id. A bilibili pick is a link that opens a new tab in the
* person's own browser, re-checked before it is drawn.
*/
function NowPlaying({ pick, autoplay, busy, onLike, onSkip, onMore }) {
	const embed = pick.source === "youtube" ? youtubeEmbedUrl(pick.video_id, autoplay) : null;
	const link = pick.source === "bilibili" ? bilibiliUrl(pick.url) : null;
	const liked = pick.feedback === "liked";
	return /* @__PURE__ */ jsxs("section", {
		"aria-label": t("page.now_playing"),
		className: "rounded-2xl border border-[var(--border)] p-4 shadow-sm",
		style: CARD_STYLE,
		"data-testid": "mood-now-playing",
		children: [
			/* @__PURE__ */ jsx("p", {
				className: "text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]",
				children: t("page.now_playing")
			}),
			embed && /* @__PURE__ */ jsx("div", {
				className: "mt-3 w-full overflow-hidden rounded-xl bg-[var(--bg-elevated)]",
				style: { aspectRatio: "16 / 9" },
				children: /* @__PURE__ */ jsx("iframe", {
					src: embed,
					title: t("page.player_title", { title: pick.title }),
					className: "h-full w-full border-0",
					allow: "autoplay; encrypted-media; picture-in-picture; fullscreen",
					allowFullScreen: true,
					referrerPolicy: "strict-origin-when-cross-origin",
					sandbox: "allow-scripts allow-same-origin allow-presentation allow-popups",
					"data-testid": "mood-youtube-frame"
				}, embed)
			}),
			link && /* @__PURE__ */ jsxs("a", {
				href: link,
				target: "_blank",
				rel: "noopener noreferrer",
				style: { aspectRatio: "3 / 1" },
				className: "mt-3 flex w-full flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-[var(--border)] text-[var(--accent)] no-underline hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]",
				"data-testid": "mood-bilibili-link",
				children: [/* @__PURE__ */ jsxs("span", {
					className: "inline-flex items-center gap-1.5 text-sm font-semibold",
					children: [/* @__PURE__ */ jsx(ExternalLink, {
						size: 15,
						"aria-hidden": "true"
					}), t("page.open_bilibili")]
				}), /* @__PURE__ */ jsx("span", {
					className: "text-xs text-[var(--muted)]",
					children: t("page.bilibili_note")
				})]
			}),
			/* @__PURE__ */ jsx("h2", {
				className: "mt-3 text-lg font-semibold leading-snug text-[var(--text)]",
				children: pick.title
			}),
			pick.artist && /* @__PURE__ */ jsx("p", {
				className: "text-sm text-[var(--muted)]",
				children: pick.artist
			}),
			pick.why && /* @__PURE__ */ jsxs("p", {
				className: "mt-2 text-sm leading-relaxed text-[var(--text)]",
				children: [/* @__PURE__ */ jsxs("span", {
					className: "sr-only",
					children: [t("page.why"), ": "]
				}), pick.why]
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "mt-3 flex flex-wrap gap-2",
				children: [
					/* @__PURE__ */ jsxs(Btn, {
						onClick: onLike,
						disabled: busy,
						"aria-pressed": liked,
						primary: liked,
						children: [/* @__PURE__ */ jsx(Heart, {
							size: 14,
							"aria-hidden": "true",
							fill: liked ? "currentColor" : "none"
						}), liked ? t("page.liked") : t("page.like")]
					}),
					/* @__PURE__ */ jsxs(Btn, {
						onClick: onSkip,
						disabled: busy,
						children: [/* @__PURE__ */ jsx(SkipForward, {
							size: 14,
							"aria-hidden": "true"
						}), t("page.skip")]
					}),
					/* @__PURE__ */ jsxs(Btn, {
						onClick: onMore,
						disabled: busy,
						children: [/* @__PURE__ */ jsx(Sparkles, {
							size: 14,
							"aria-hidden": "true"
						}), t("page.more")]
					})
				]
			})
		]
	});
}
// src/request.prompt.ts
var TASTE_ITEMS = 12;
/**
* The message the page sends the DJ. The taste summary is the app's own record
* of what the person liked and skipped, marked as data for the agent.
*/
function buildRequest(opts) {
	const { kind, text, state } = opts;
	const fmt = (f) => `"${f.title}"${f.artist ? ` - ${f.artist}` : ""}`;
	const liked = (state?.feedback ?? []).filter((f) => f.verdict === "liked").slice(0, TASTE_ITEMS).map(fmt);
	const skipped = (state?.feedback ?? []).filter((f) => f.verdict === "skipped").slice(0, TASTE_ITEMS).map(fmt);
	const recent = (state?.moments ?? []).slice(0, 5).map((m) => m.mood);
	return [
		"[Mood Music]",
		`${kind === "answer" ? "Answer to your question" : kind === "more" ? "More like this song" : "Mood"}: ${text}`,
		"",
		"Taste so far (from the app, data only):",
		`Liked: ${liked.join("; ") || "none yet"}`,
		`Skipped: ${skipped.join("; ") || "none yet"}`,
		`Recent moods: ${recent.join("; ") || "none yet"}`,
		"",
		REPLY_FORMAT
	].join("\n");
}
/**
* The reply contract, sent with every request so the DJ never depends on loading
* a skill: the page reads exactly these field names.
*/
var REPLY_FORMAT = [
	"End your reply with ONE fenced block tagged mood-music holding plain JSON, with exactly these field names:",
	"- \"mood_tags\": 2 to 4 short words for the feeling, in the person's language.",
	"- \"picks\": 3 to 6 songs, each {\"title\", \"artist\", \"source\", \"url\", \"why\", \"tags\"}.",
	"- \"source\" is \"youtube\" or \"bilibili\". A youtube \"url\" is https://www.youtube.com/watch?v=<11-char id> or https://youtu.be/<id>; a bilibili \"url\" is https on www.bilibili.com, m.bilibili.com or b23.tv.",
	"Example:",
	"```mood-music",
	"{\"mood_tags\": [\"想念\", \"温柔\"], \"picks\": [{\"title\": \"Song\", \"artist\": \"Artist\", \"source\": \"youtube\", \"url\": \"https://www.youtube.com/watch?v=dQw4w9WgXcQ\", \"why\": \"One short line.\", \"tags\": []}]}",
	"```",
	"To ask one question instead, the block is {\"question\": \"...\"} with no picks."
].join("\n");
// src/replyParse.ts
/**
* Read the DJ agent's `mood-music` block out of a reply.
*
* The agent found its links on web pages, so the block is untrusted: each pick
* is checked here with `links.ts` and reduced to the fields the page draws, a
* bad pick is dropped, and lengths are cut to the backend's limits. Text is only
* ever rendered as React text, never as HTML.
*/
var FENCE_RE = /```mood-music[^\n]*\n([\s\S]*?)```/g;
var MAX_PICKS = 12;
function text(value, limit) {
	return typeof value === "string" ? value.trim().slice(0, limit) : "";
}
function tags(value) {
	if (!Array.isArray(value)) return [];
	return value.filter((t) => typeof t === "string" && t.trim().length > 0).map((t) => t.trim().slice(0, 40)).slice(0, 8);
}
function pick(raw) {
	if (!raw || typeof raw !== "object") return null;
	const r = raw;
	const title = text(r.title, 200);
	if (!title) return null;
	const base = {
		title,
		artist: text(r.artist, 200),
		why: text(r.why, 400),
		tags: tags(r.tags)
	};
	const source = r.source ?? r.platform;
	if (source === "youtube") {
		const id = r.video_id !== void 0 ? validVideoId(r.video_id) : youtubeVideoId(r.url);
		return id ? {
			...base,
			source: "youtube",
			video_id: id
		} : null;
	}
	if (source === "bilibili") {
		const url = bilibiliUrl(r.url);
		return url ? {
			...base,
			source: "bilibili",
			url
		} : null;
	}
	return null;
}
/** The LAST `mood-music` block in *content*, or null when there is none that parses. */
function parseDjReply(content) {
	const blocks = [...content.matchAll(FENCE_RE)];
	const last = blocks[blocks.length - 1];
	if (!last) return null;
	let data;
	try {
		data = JSON.parse(last[1]);
	} catch {
		return null;
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) return null;
	const d = data;
	const rawPicks = Array.isArray(d.picks) ? d.picks.slice(0, MAX_PICKS) : [];
	const picks = rawPicks.map(pick).filter((p) => p !== null);
	return {
		question: text(d.question, 300),
		moodTags: tags(d.mood_tags ?? d.moods),
		picks,
		dropped: rawPicks.length - picks.length
	};
}
/** A short stable id for a reply, so the page queues each reply once. */
function replySource(content) {
	let h = 0;
	for (let i = 0; i < content.length; i++) h = (h << 5) - h + content.charCodeAt(i) | 0;
	return `r${(h >>> 0).toString(36)}-${content.length}`;
}
// src/reducedMotion.ts
var QUERY = "(prefers-reduced-motion: reduce)";
/** Whether the person asked for reduced motion, following later changes. */
function usePrefersReducedMotion() {
	const read = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(QUERY).matches;
	const [reduce, setReduce] = useState(read);
	useEffect(() => {
		if (typeof window.matchMedia !== "function") return;
		const mq = window.matchMedia(QUERY);
		const on = () => setReduce(mq.matches);
		mq.addEventListener?.("change", on);
		return () => mq.removeEventListener?.("change", on);
	}, []);
	return reduce;
}
// src/MoodMusicPage.tsx
/**
* MoodMusicPage — say how you feel, hear songs with the same feeling.
*
* One screen: a mood input with mood chips, the DJ's one question when it has
* one, the now-playing card and the queue; a second tab keeps the moments. The
* page talks to the DJ agent through one hidden worker slot (`api.ts`): it sends
* the mood plus the app's taste summary, polls the slot until the turn ends, and
* reads the reply's `mood-music` block (`replyParse.ts`). Every link is checked
* there and again by the backend before it is queued.
*/
var errMessage = (e) => e instanceof Error ? e.message : typeof e === "string" ? e : "";
/** Poll cadence while the DJ works, and how long before the page gives up. */
var POLL_MS = 1500;
var MOOD_LABELS = {
	calm: "page.mood_calm",
	sad: "page.mood_sad",
	happy: "page.mood_happy",
	missing: "page.mood_missing",
	fired: "page.mood_fired"
};
var moodLabel = (key) => t(MOOD_LABELS[key]);
function MoodMusicPage() {
	const reduceMotion = usePrefersReducedMotion();
	const appApi = useAppApi();
	const moodApi = useMemo(() => createMoodApi(appApi), [appApi]);
	const [tab, setTab] = useState("listen");
	const [state, setState] = useState();
	const [text, setText] = useState("");
	const [chip, setChip] = useState(null);
	const [answer, setAnswer] = useState("");
	const [question, setQuestion] = useState("");
	const [look, setLook] = useState("neutral");
	const [currentId, setCurrentId] = useState(null);
	const [autoplay, setAutoplay] = useState(false);
	const [motionPaused, setMotionPaused] = useState(false);
	const [pending, setPending] = useState(null);
	const [approval, setApproval] = useState(false);
	const { openChat } = useChatLauncher();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(null);
	const [droppedAll, setDroppedAll] = useState(0);
	const [notice, setNotice] = useState(null);
	const slotRef = useRef(null);
	const momentRef = useRef("");
	const lastAskRef = useRef("");
	const chipRef = useRef(null);
	chipRef.current = chip;
	useEffect(() => {
		let live = true;
		moodApi.state().then((s) => {
			if (live) setState(s);
		}).catch((e) => {
			if (live) setError(errMessage(e) || "load_failed");
		});
		return () => {
			live = false;
		};
	}, [moodApi]);
	const queue = state?.queue ?? [];
	const current = queue.find((p) => p.id === currentId) ?? queue.find((p) => p.feedback !== "skipped") ?? null;
	/** Send one turn to the DJ and start waiting for its reply. */
	const ask = useCallback(async (message) => {
		const known = slotRef.current ?? (await moodApi.openSlot()).key;
		const before = await moodApi.getSlot(known).catch(() => void 0);
		lastAskRef.current = message;
		slotRef.current = await moodApi.ask(message);
		setPending({
			momentId: momentRef.current,
			baseline: replySource(latestReply(before)),
			startedAt: Date.now()
		});
	}, [moodApi]);
	const run = useCallback(async (work) => {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			await work();
		} catch (e) {
			setError(errMessage(e) || "unknown");
			setPending(null);
		} finally {
			setBusy(false);
		}
	}, []);
	/** Record the mood and ask the DJ for songs. */
	const startMood = (mood, look) => {
		if (!mood || pending || busy) return;
		setLook(look);
		setQuestion("");
		run(async () => {
			const moment = await moodApi.addMoment(mood);
			momentRef.current = moment.id;
			setState((s) => s ? {
				...s,
				moments: [moment, ...s.moments]
			} : s);
			await ask(buildRequest({
				kind: "mood",
				text: mood,
				state
			}));
		});
	};
	const submitMood = (e) => {
		e.preventDefault();
		const typed = text.trim();
		startMood(typed || (chip ? moodLabel(chip) : ""), chip ?? moodLookFor([typed]));
	};
	/** A chip is a search: its mood, plus whatever is typed in the box. */
	const pickChip = (key) => {
		const typed = text.trim();
		setChip(key);
		startMood(typed ? `${moodLabel(key)}: ${typed}` : moodLabel(key), key);
	};
	const submitAnswer = (e) => {
		e.preventDefault();
		const reply = answer.trim();
		if (!reply || pending) return;
		setQuestion("");
		setAnswer("");
		run(() => ask(buildRequest({
			kind: "answer",
			text: reply,
			state
		})));
	};
	const moreLike = (pick) => {
		if (pending) return;
		const song = pick.artist ? `"${pick.title}" - ${pick.artist}` : `"${pick.title}"`;
		run(() => ask(buildRequest({
			kind: "more",
			text: song,
			state
		})));
	};
	useEffect(() => {
		if (!pending) return;
		let live = true;
		let clock = pending.startedAt;
		setApproval(false);
		const timer = setInterval(async () => {
			const key = slotRef.current;
			if (!key || !live) return;
			let slot;
			try {
				slot = await moodApi.getSlot(key);
			} catch {
				slot = void 0;
			}
			if (!live) return;
			const parked = !!slot?.running && awaitingApproval(slot);
			setApproval(parked);
			if (parked) {
				clock = Date.now();
				return;
			}
			if (Date.now() - clock > 3e5) {
				live = false;
				setPending(null);
				setError("timeout");
				return;
			}
			if (!slot) return;
			const reply = latestReply(slot);
			const source = replySource(reply);
			if (slot.running || !reply || source === pending.baseline) return;
			live = false;
			setPending(null);
			const parsed = parseDjReply(reply);
			if (!parsed) {
				setError("unreadable");
				return;
			}
			const tagLook = moodLookFor(parsed.moodTags);
			if (!chipRef.current && tagLook !== "neutral") setLook(tagLook);
			if (parsed.picks.length === 0) {
				if (parsed.question) setQuestion(parsed.question);
				else if (parsed.dropped > 0) {
					setDroppedAll(parsed.dropped);
					setError("all_dropped");
				} else setError("unreadable");
				return;
			}
			if (parsed.dropped > 0) setNotice(t("page.dropped", { count: parsed.dropped }));
			try {
				const { queue: next } = await moodApi.setQueue({
					source,
					moment_id: pending.momentId || void 0,
					mood_tags: parsed.moodTags,
					picks: parsed.picks
				});
				setState(await moodApi.state());
				setCurrentId(next[0]?.id ?? null);
				setAutoplay(false);
			} catch (e) {
				setError(errMessage(e) || "unknown");
			}
		}, POLL_MS);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, [pending, moodApi]);
	const giveFeedback = (pick, verdict) => {
		run(async () => {
			const updated = await moodApi.feedback(pick.id, verdict);
			setState(await moodApi.state().catch(() => state));
			if (verdict === "skipped") {
				const rest = queue.filter((p) => p.id !== updated.id && p.feedback !== "skipped");
				setCurrentId(rest[0]?.id ?? null);
				setAutoplay(true);
			}
		});
	};
	const playPick = (pick) => {
		setCurrentId(pick.id);
		setAutoplay(true);
	};
	const errorText = error === null ? null : error === "unreadable" ? t("page.error_unreadable") : error === "all_dropped" ? t("page.error_all_dropped", { count: droppedAll }) : error === "timeout" ? t("page.error_timeout") : t("page.error_generic", { code: error });
	const working = busy || !!pending;
	return /* @__PURE__ */ jsxs("div", {
		className: "relative flex h-full flex-col overflow-hidden",
		"data-testid": "mood-music-page",
		children: [/* @__PURE__ */ jsx(MoodBackdrop, {
			look,
			moving: !reduceMotion && !motionPaused
		}), /* @__PURE__ */ jsxs("div", {
			className: "relative flex h-full flex-col",
			children: [
				/* @__PURE__ */ jsx(PageHeader, {
					title: t("page.title"),
					subtitle: t("page.subtitle"),
					actions: reduceMotion ? void 0 : /* @__PURE__ */ jsxs(Btn, {
						onClick: () => setMotionPaused((p) => !p),
						"data-testid": "mood-motion-toggle",
						children: [/* @__PURE__ */ jsx(Waves, {
							size: 14,
							"aria-hidden": "true"
						}), motionPaused ? t("page.play_motion") : t("page.pause_motion")]
					})
				}),
				/* @__PURE__ */ jsx("div", {
					className: "px-4 pb-2",
					children: /* @__PURE__ */ jsx(SegmentedControl, {
						value: tab,
						onChange: (v) => setTab(v),
						segments: [{
							key: "listen",
							label: t("page.tab_listen")
						}, {
							key: "moments",
							label: t("page.tab_moments")
						}]
					})
				}),
				/* @__PURE__ */ jsx("div", {
					className: "flex-1 overflow-y-auto px-4 pb-6",
					children: tab === "moments" ? /* @__PURE__ */ jsx("div", {
						className: "mx-auto max-w-5xl",
						children: /* @__PURE__ */ jsx(MomentsTab, { moments: state?.moments ?? [] })
					}) : /* @__PURE__ */ jsxs("div", {
						className: "mx-auto flex max-w-5xl flex-col gap-4",
						children: [
							/* @__PURE__ */ jsxs("form", {
								onSubmit: submitMood,
								className: "rounded-2xl border border-[var(--border)] p-4 shadow-sm",
								style: CARD_STYLE,
								children: [
									/* @__PURE__ */ jsx("label", {
										id: "mood-input-label",
										htmlFor: "mood-input",
										className: "text-sm font-medium text-[var(--text)]",
										children: t("page.mood_label")
									}),
									/* @__PURE__ */ jsxs("div", {
										className: "mt-2 flex gap-2",
										children: [/* @__PURE__ */ jsx("input", {
											id: "mood-input",
											"aria-labelledby": "mood-input-label",
											value: text,
											onChange: (e) => setText(e.target.value),
											maxLength: 200,
											placeholder: t("page.mood_placeholder"),
											className: "min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
										}), /* @__PURE__ */ jsxs(Btn, {
											type: "submit",
											primary: true,
											disabled: working || !text.trim() && !chip,
											children: [/* @__PURE__ */ jsx(Search, {
												size: 14,
												"aria-hidden": "true"
											}), t("page.find")]
										})]
									}),
									/* @__PURE__ */ jsx("div", {
										role: "group",
										"aria-label": t("page.mood_chips"),
										className: "mt-3 flex flex-wrap gap-2",
										children: MOOD_KEYS.map((key) => /* @__PURE__ */ jsx("button", {
											type: "button",
											"aria-pressed": chip === key,
											onClick: () => pickChip(key),
											disabled: working,
											className: `rounded-full border px-3 py-1 text-xs transition-colors ${chip === key ? "border-[var(--accent)] bg-[var(--accent-subtle)] font-semibold text-[var(--accent)]" : "border-[var(--border)] text-[var(--text)] hover:bg-[var(--bg-hover)]"}`,
											children: moodLabel(key)
										}, key))
									}),
									working && /* @__PURE__ */ jsx("p", {
										role: "status",
										className: "mt-3 text-xs text-[var(--muted)]",
										children: t("page.finding")
									}),
									/* @__PURE__ */ jsx(ErrorNotice, {
										className: "mt-2",
										message: errorText
									}),
									(error === "unreadable" || error === "all_dropped" || error === "timeout") && lastAskRef.current && !working && /* @__PURE__ */ jsx(Btn, {
										type: "button",
										className: "mt-2",
										onClick: () => {
											const again = lastAskRef.current;
											run(() => ask(again));
										},
										children: t("page.retry")
									}),
									notice && /* @__PURE__ */ jsx("p", {
										className: "mt-2 text-xs text-[var(--muted)]",
										children: notice
									})
								]
							}),
							pending && approval && /* @__PURE__ */ jsxs("section", {
								role: "alert",
								"aria-labelledby": "mood-approval-title",
								className: "rounded-2xl border border-[var(--accent)] p-4",
								style: CARD_STYLE,
								"data-testid": "mood-approval",
								children: [
									/* @__PURE__ */ jsxs("p", {
										id: "mood-approval-title",
										className: "flex items-center gap-1.5 text-sm font-semibold text-[var(--text)]",
										children: [/* @__PURE__ */ jsx(ShieldCheck, {
											size: 14,
											"aria-hidden": "true"
										}), t("page.approval_title")]
									}),
									/* @__PURE__ */ jsxs("ol", {
										className: "mt-2 list-decimal space-y-1 pl-5 text-sm text-[var(--text)]",
										children: [
											/* @__PURE__ */ jsx("li", { children: t("page.approval_step_open") }),
											/* @__PURE__ */ jsx("li", { children: t("page.approval_step_trust") }),
											/* @__PURE__ */ jsx("li", { children: t("page.approval_step_back") })
										]
									}),
									/* @__PURE__ */ jsx(Btn, {
										className: "mt-3",
										primary: true,
										onClick: () => {
											if (slotRef.current) openChat({ slotKey: slotRef.current });
										},
										children: t("page.approval_open")
									})
								]
							}),
							question && /* @__PURE__ */ jsxs("form", {
								onSubmit: submitAnswer,
								className: "rounded-2xl border border-[var(--accent)] p-4",
								style: CARD_STYLE,
								"data-testid": "mood-question",
								children: [
									/* @__PURE__ */ jsxs("p", {
										className: "flex items-center gap-1.5 text-xs font-semibold text-[var(--accent)]",
										children: [/* @__PURE__ */ jsx(MessageCircleQuestion, {
											size: 14,
											"aria-hidden": "true"
										}), t("page.question_label")]
									}),
									/* @__PURE__ */ jsx("p", {
										className: "mt-1 text-sm text-[var(--text)]",
										children: question
									}),
									/* @__PURE__ */ jsxs("div", {
										className: "mt-2 flex gap-2",
										children: [/* @__PURE__ */ jsx("input", {
											"aria-label": t("page.answer_placeholder"),
											value: answer,
											onChange: (e) => setAnswer(e.target.value),
											maxLength: 300,
											placeholder: t("page.answer_placeholder"),
											className: "min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
										}), /* @__PURE__ */ jsx(Btn, {
											type: "submit",
											primary: true,
											disabled: working || !answer.trim(),
											children: t("page.send_answer")
										})]
									})
								]
							}),
							/* @__PURE__ */ jsxs("div", {
								className: "grid items-start gap-4",
								style: { gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))" },
								children: [current ? /* @__PURE__ */ jsx(NowPlaying, {
									pick: current,
									autoplay,
									busy: working,
									onLike: () => giveFeedback(current, current.feedback === "liked" ? "" : "liked"),
									onSkip: () => giveFeedback(current, "skipped"),
									onMore: () => moreLike(current)
								}) : /* @__PURE__ */ jsx(EmptyState, {
									icon: /* @__PURE__ */ jsx(Play, { size: 28 }),
									title: t("page.empty_title"),
									subtitle: t("page.empty_body")
								}), queue.length > 1 && /* @__PURE__ */ jsxs("section", {
									"aria-label": t("page.queue"),
									children: [/* @__PURE__ */ jsx("h3", {
										className: "mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]",
										children: t("page.queue")
									}), /* @__PURE__ */ jsx("ul", {
										className: "flex flex-col gap-1.5",
										"data-testid": "mood-queue",
										children: queue.map((p) => /* @__PURE__ */ jsx("li", { children: /* @__PURE__ */ jsxs("button", {
											type: "button",
											onClick: () => playPick(p),
											"aria-current": current?.id === p.id ? "true" : void 0,
											"aria-label": t("page.play", { title: p.title }),
											className: `flex w-full items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors ${current?.id === p.id ? "border-[var(--accent)] bg-[var(--accent-subtle)]" : "border-[var(--border)] hover:bg-[var(--bg-hover)]"} ${p.feedback === "skipped" ? "opacity-50" : ""}`,
											style: current?.id === p.id ? void 0 : CARD_STYLE,
											children: [/* @__PURE__ */ jsxs("span", {
												className: "min-w-0 flex-1",
												children: [/* @__PURE__ */ jsx("span", {
													className: "block truncate text-sm text-[var(--text)]",
													children: p.title
												}), /* @__PURE__ */ jsx("span", {
													className: "block truncate text-xs text-[var(--muted)]",
													children: p.artist
												})]
											}), /* @__PURE__ */ jsx("span", {
												className: "shrink-0 rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--muted)]",
												children: p.source === "youtube" ? t("page.source_youtube") : t("page.source_bilibili")
											})]
										}) }, p.id))
									})]
								})]
							})
						]
					})
				})
			]
		})]
	});
}
// src/index.tsx
/**
* The bundle's entry: AppHost lazy-imports this module and renders its default
* export as the app's page. Subscribing to the host's language generation
* repaints the page on a language switch.
*/
function MoodMusicApp() {
	useLanguageGeneration();
	return /* @__PURE__ */ jsx(MoodMusicPage, {});
}
export { MoodMusicApp as default };
