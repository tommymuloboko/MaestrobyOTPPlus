import { countries, type TCountryCode } from 'countries-list';
import { currencies } from 'countries-list/currencies';
import { Select } from './ui';

const COUNTRY_OPTIONS = Object.entries(countries)
  .map(([code, country]) => [code, `${country.name} (${code})`] as [string, string])
  .sort((a, b) => a[1].localeCompare(b[1]));

const CURRENCY_OPTIONS = [...new Set(Object.values(countries).flatMap((country) => country.currency))]
  .filter((code) => {
    const currency = currencies[code as keyof typeof currencies];
    return currency && !currency.withdrawn;
  })
  .sort()
  .map((code) => [code, `${currencies[code as keyof typeof currencies].name} (${code})`] as [string, string]);

export default function CountryCurrencyFields({
  country,
  currency,
  onCountryChange,
  onCurrencyChange,
}: {
  country: string;
  currency: string;
  onCountryChange: (value: string) => void;
  onCurrencyChange: (value: string) => void;
}) {
  return (
    <div className="row2">
      <Select
        label="Country (ISO)"
        value={country}
        onChange={(value) => {
          onCountryChange(value);
          const defaultCurrency = countries[value as TCountryCode]?.currency[0];
          if (defaultCurrency) onCurrencyChange(defaultCurrency);
        }}
        options={COUNTRY_OPTIONS}
      />
      <Select label="Currency" value={currency} onChange={onCurrencyChange} options={CURRENCY_OPTIONS} />
    </div>
  );
}
