//! Type declaration cho `luckyexcel` (không ship kèm .d.ts).
//! Chỉ dùng `transformExcelToLucky` để nạp xlsx → dữ liệu FortuneSheet.

declare module "luckyexcel" {
  /** Dữ liệu FortuneSheet do LuckyExcel parse (exportJson). */
  export interface LuckyExcelExport {
    sheets: Array<Record<string, any>>;
  }

  const LuckyExcel: {
    /**
     * Chuyển 1 file Excel (File/Blob) → dữ liệu FortuneSheet.
     * @param excelFile - đối tượng File (có `.name`).
     * @param callback - nhận `exportJson` (dạng `{ sheets: [...] }`).
     */
    transformExcelToLucky(
      excelFile: File | Blob,
      callback: (exportJson: LuckyExcelExport, luckysheetfile?: string) => void,
    ): void;
  };

  export default LuckyExcel;
}
