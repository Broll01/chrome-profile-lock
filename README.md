# Chrome Profile Lock v2.0

## ইনস্টল করার নিয়ম
1. `chrome://extensions` খুলুন এবং **Developer mode** চালু করুন।
2. পুরোনো ভার্সন থাকলে আগে সেটা **Remove** করুন (অথবা **Reload** দিন)।
3. **Load unpacked** চেপে এই ফোল্ডারটা সিলেক্ট করুন।
4. প্রথমবার Settings পেজ আপনা-আপনি খুলবে। সেখানে PIN / Password সেট করুন।
5. Incognito কভার করতে চাইলে এক্সটেনশনের Details থেকে **Allow in Incognito** চালু করুন।

> আগের ভার্সনে সেট করা PIN কাজ করবে। প্রথমবার সফলভাবে Unlock করলেই সেটা নতুন, শক্তিশালী ফরম্যাটে আপগ্রেড হয়ে যাবে।

## ফিচার
- **Lock Screen:** PIN / Password / Password+PIN, Show/Hide বাটন, সুন্দর Error Message, Custom Logo ও Title, Dark/Light/Auto থিম, Clock ও Date।
- **Auto-Lock:** Inactivity (১–৬০ মিনিট), Chrome চালু হলে Lock, Computer Screen Lock হলে Lock, Sleep থেকে ফিরলে Lock (best effort), নির্দিষ্ট দিন ও সময়ে Schedule Lock।
- **Security:** ৫ বার ভুল হলে Lockout (৩০ সেকেন্ড, তারপর দ্বিগুণ হতে হতে সর্বোচ্চ ১৫ মিনিট)। Counter storage-এ থাকে, তাই Lock Window বন্ধ করে আবার খুললেও Reset হয় না। PIN/Password বদলাতে পুরোনোটা লাগে। Activity Log শুধু এই পিসিতে থাকে।
- **Tab ও Session:** Lock-এর আগে Window ও Tab-এর তথ্য সংরক্ষণ, Unlock-এর পর আগের Window ও অবস্থায় ফেরা, একাধিক Window থাকলেও একটাই Lock Screen, Crash বা Restart-এর পরেও Lock বজায় থাকা, আর Settings থেকে Tab Restore (Incognito Tab কখনও সংরক্ষণ করা হয় না)।
- **Quick Controls:** `Ctrl+Shift+L` শর্টকাট (বদলাতে `chrome://extensions/shortcuts`), Popup-এ Lock Status ও Auto-lock On/Off, Settings Page।

## বাগ ফিক্স: একাধিক Lock Popup
আগে Focus-change ইভেন্ট নতুন Lock Window-কে সাধারণ Window ভেবে ভুল করত এবং আরেকটা Lock Window খুলত। এখন সব কাজ একটা Queue দিয়ে ক্রমানুসারে চলে, আর নতুন Window খোলার আগে সব Window স্ক্যান করা হয়। একাধিক পেলে বাড়তিগুলো বন্ধ হয়ে যায়।

## জরুরি অবস্থা: Password ভুলে গেলে
এই Lock ইচ্ছা করেই সহজে খোলে না, Chrome Restart করলেও Lock থেকে যায়। ভুলে গেলে:
1. Chrome বন্ধ করুন।
2. Chrome-এর শর্টকাটে `--disable-extensions` ফ্ল্যাগ দিয়ে চালান।
3. `chrome://extensions` থেকে এই এক্সটেনশন Remove করুন।
4. তারপর আবার ইনস্টল করে নতুন PIN সেট করুন।

## সীমাবদ্ধতা
এটা একটা প্রতিবন্ধক, সম্পূর্ণ নিরাপত্তা দেয়াল নয়। কেউ Chrome-এর অন্য Profile বা Guest Mode খুললে, কিংবা এক্সটেনশন মুছে দিলে এটা আটকাতে পারবে না। আসল সুরক্ষার জন্য Windows Lock (Win+L) ব্যবহার করুন।
