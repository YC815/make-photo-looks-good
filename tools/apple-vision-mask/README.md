# apple-vision-mask

用 Apple Vision 框架（「照片」App 長按抓主體背後的同一套模型）產生與原圖同尺寸的遮罩，再丟回網頁編輯器的「匯入遮罩」。

需求：macOS 14 以上、已安裝 Xcode 或 Command Line Tools（`xcode-select --install`）。

```sh
swift tools/apple-vision-mask/lift-subject.swift photo.jpg                # → photo.mask.png（所有主體）
swift tools/apple-vision-mask/lift-subject.swift photo.jpg --at 0.5,0.6   # 只要該點底下的主體（0～1，從左上角算）
swift tools/apple-vision-mask/lift-subject.swift photo.jpg --cutout       # 另外輸出 photo.cutout.png
```

遮罩是白色＝主體、黑色＝背景的灰階 PNG。照片的 EXIF 方向會先轉正，跟瀏覽器顯示的方向一致。
