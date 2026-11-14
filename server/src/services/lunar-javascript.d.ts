declare module 'lunar-javascript' {
  const lunar: {
    Solar: {
      fromYmd(year: number, month: number, day: number): {
        getFestivals(): string[];
        getLunar(): {
          toString(): string;
          getFestivals(): string[];
          getJieQi(): string;
        };
      };
    };
  };
  export default lunar;
}
