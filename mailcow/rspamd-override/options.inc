# /opt/mailcow-dockerized/data/conf/rspamd/override.d/options.inc
#
# Überschreibt die globalen Spam-Scores von Mailcow.
# Diese Datei wird von Mailcow eingelesen, nachdem die lokalen Konfigurationen geladen wurden.

# Setze globale Spam-Schwellwerte
# (Standard in Mailcow ist oft: greylist 4.0, add_header 6.0, reject 15.0)
#
# actions {
#   reject = 15.0;
#   add_header = 6.0;
#   greylist = 4.0;
# }
