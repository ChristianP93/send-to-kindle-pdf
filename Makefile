BUMP ?= patch

.PHONY: publish-npm

publish-npm:
	git checkout main
	git pull
	npm version $(BUMP)
	git push --follow-tags
